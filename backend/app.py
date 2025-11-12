"""FastAPI application that exposes a GPT-powered dataset generator endpoint."""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, Iterable, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


class ColumnSpec(BaseModel):
    """Schema definition for a generated column."""

    name: str
    type: str
    description: Optional[str] = None


class TableSpec(BaseModel):
    """Schema definition for a generated table."""

    name: str
    description: Optional[str] = None
    columns: List[ColumnSpec] = Field(default_factory=list)
    sample_rows: List[Dict[str, Any]] = Field(default_factory=list, alias="sampleRows")


class GenerateRequest(BaseModel):
    """Payload received from the frontend when the user clicks *Generate*."""

    rule: str = Field(..., min_length=1, description="High level instructions for GPT")
    example: Optional[str] = Field(
        default=None,
        description="Optional example scenario that provides extra context for GPT.",
    )

    def cleaned_rule(self) -> str:
        return self.rule.strip()

    def cleaned_example(self) -> Optional[str]:
        return self.example.strip() or None if self.example else None


class GenerateResponse(BaseModel):
    """Response sent back to the frontend."""

    prompt: str
    tables: List[TableSpec]
    notes: Optional[str] = None
    used_fallback: bool = Field(default=False, alias="usedFallback")
    raw_response: Optional[str] = Field(default=None, alias="rawResponse")


SYSTEM_INSTRUCTIONS = (
    "You are a helpful assistant that designs synthetic moderation datasets. "
    "Given a rule and optional example, build a concise JSON description of the "
    "tables that would help test the rule."
)

JSON_SCHEMA_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "dataset_plan",
        "schema": {
            "type": "object",
            "properties": {
                "notes": {"type": "string"},
                "tables": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "columns": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"},
                                        "type": {"type": "string"},
                                        "description": {"type": "string"},
                                    },
                                    "required": ["name", "type"],
                                },
                            },
                            "sampleRows": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "additionalProperties": {"type": "string"},
                                },
                            },
                        },
                        "required": ["name", "columns"],
                    },
                },
            },
            "required": ["tables"],
            "additionalProperties": False,
        },
    },
}


def create_app() -> FastAPI:
    app = FastAPI(title="ModDash Generator", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/")
    async def root() -> Dict[str, str]:
        """Simple heartbeat endpoint."""

        return {"status": "ok"}

    @app.post("/generate", response_model=GenerateResponse)
    async def generate_dataset(payload: GenerateRequest) -> GenerateResponse:
        rule = payload.cleaned_rule()
        if not rule:
            raise HTTPException(status_code=400, detail="The rule field cannot be empty.")

        example = payload.cleaned_example()
        prompt = build_prompt(rule, example)

        llm_response = await call_openai(prompt)

        used_fallback = False
        tables: List[TableSpec]
        notes: Optional[str] = None
        raw_response: Optional[str] = None

        if llm_response is not None:
            raw_response = llm_response
            parsed = try_parse_tables(llm_response)
            if parsed is not None:
                tables, notes = parsed
            else:
                used_fallback = True
                notes = (
                    "The language model returned an unexpected response. "
                    "Falling back to a deterministic dataset."
                )
                tables = build_fallback_tables(rule, example)
        else:
            used_fallback = True
            notes = (
                "A live connection to the OpenAI API could not be established. "
                "Using a deterministic dataset so development can continue."
            )
            tables = build_fallback_tables(rule, example)

        return GenerateResponse(
            prompt=prompt,
            tables=tables,
            notes=notes,
            usedFallback=used_fallback,
            rawResponse=raw_response,
        )

    return app


app = create_app()


def build_prompt(rule: str, example: Optional[str]) -> str:
    """Create the prompt that will be sent to GPT."""

    base_instructions = (
        "Design a small synthetic database that can be used to test the moderation rule below. "
        "Return JSON that matches the dataset_plan schema provided in the system instructions. "
        "Keep table and column names short and snake_case. Provide at most three sample rows per table."
    )

    sections = [base_instructions, f"Moderation rule: {rule.strip()}"]
    if example:
        sections.append(f"Example scenario to consider: {example.strip()}")

    return "\n\n".join(sections)


async def call_openai(prompt: str) -> Optional[str]:
    """Send the prompt to OpenAI's Responses API when credentials are available."""

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    api_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    url = f"{api_base.rstrip('/')}/responses"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": SYSTEM_INSTRUCTIONS},
            {"role": "user", "content": prompt},
        ],
        "response_format": JSON_SCHEMA_RESPONSE_FORMAT,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, json.JSONDecodeError):
        return None

    outputs = data.get("output") or data.get("outputs")
    if not outputs:
        # Fallback to the old chat completions format if necessary.
        choices = data.get("choices")
        if choices:
            message = choices[0].get("message", {})
            return message.get("content")
        return None

    # The new Responses API returns a list of content blocks; concatenate text segments.
    text_parts: List[str] = []
    for item in outputs:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get("type") == "output_text":
                text_parts.append(block.get("text", ""))
    return "".join(text_parts) if text_parts else None


def try_parse_tables(raw_text: str) -> Optional[tuple[List[TableSpec], Optional[str]]]:
    """Try to parse the language model output into the expected response model."""

    raw_text = raw_text.strip()
    if not raw_text:
        return None

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        return None

    tables_data = payload.get("tables")
    if not isinstance(tables_data, list):
        return None

    tables = [TableSpec.model_validate(table) for table in tables_data]
    notes = payload.get("notes") if isinstance(payload.get("notes"), str) else None
    return tables, notes


def build_fallback_tables(rule: str, example: Optional[str]) -> List[TableSpec]:
    """Generate a deterministic dataset plan when GPT is unavailable."""

    keywords = list(extract_keywords(rule))
    if example:
        keywords.extend(extract_keywords(example))

    if not keywords:
        keywords = ["mod_rule", "flag", "confidence"]

    # Use the first keyword to name the table and create columns from the rest.
    table_name = f"{keywords[0]}_cases"
    column_keywords = keywords[1:] or ["description", "severity", "action"]

    columns = [
        ColumnSpec(
            name=f"{kw}_text" if not kw.endswith("_text") else kw,
            type="string",
            description=f"Synthetic text related to {kw.replace('_', ' ')}.",
        )
        for kw in column_keywords[:3]
    ]

    # Always include a decision column.
    columns.append(
        ColumnSpec(
            name="decision",
            type="string",
            description="Expected moderation decision (allow, review, block, etc.).",
        )
    )

    sample_rows: List[Dict[str, Any]] = []
    for idx in range(1, min(3, len(column_keywords) + 1) + 1):
        row = {column.name: f"Example {idx} {column.name.replace('_', ' ')}" for column in columns}
        row["decision"] = "review" if idx == 2 else ("block" if idx % 2 else "allow")
        sample_rows.append(row)

    table = TableSpec(
        name=table_name,
        description="Fallback dataset generated without GPT.",
        columns=columns,
        sampleRows=sample_rows,
    )

    return [table]


def extract_keywords(text: str) -> Iterable[str]:
    """Convert free-form text into snake_case keywords."""

    words = re.findall(r"[A-Za-z0-9]+", text.lower())
    seen = set()
    for word in words:
        if len(word) < 3:
            continue
        keyword = word.replace("-", "_")
        if keyword in seen:
            continue
        seen.add(keyword)
        yield keyword


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
