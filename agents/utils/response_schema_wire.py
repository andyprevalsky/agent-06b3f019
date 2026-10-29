"""Finite typed native wire for canonical nested response schemas.

Native providers require an acyclic JSON schema. The values in this node table
can describe nested fields without making the provider's schema recursive.
Canonical public dictionaries and their serialization remain nested.
"""

from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

from utils.response_schema_constraints import bounds_from_entries
from utils.final_presentation import FinalPresentation

PublicType = Literal[
    "str", "int", "float", "bool", "list[str]", "list[int]", "object",
    "list[object]", "file_pointer", "list[file_pointer]",
]
InternalType = Literal[
    "str", "int", "float", "bool", "list[str]", "list[int]", "object",
    "list[object]", "file_pointer", "list[file_pointer]",
    "session_file_pointer", "list[session_file_pointer]",
]


class WireBound(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["minItems", "maxItems", "minLength", "maxLength"]
    value: int = Field(ge=0)


class PublicNode(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, description="Unique identifier within this node table.")
    parent_id: str | None = Field(
        description="Null for a root output field; otherwise its object/list[object] parent's id."
    )
    position: int = Field(ge=0, description="Contiguous zero-based order among sibling fields.")
    name: str = Field(min_length=1, description="Canonical field name.")
    type: PublicType
    required: bool
    nullable: bool
    description: str
    constraints: list[WireBound]


class InternalNode(PublicNode):
    type: InternalType


@lru_cache(maxsize=8)
def wire_model(internal=False, reasoning=False, title=False):
    node = InternalNode if internal else PublicNode
    meaning = (
        "Output fields with at least one required key; optional keys may be omitted."
        if reasoning else
        "Output fields. Use file_pointer for open-ended multi-attribute collections; keep small results inline. "
        "constraints set size bounds; required=false permits omission."
    )
    fields = {
        "nodes": (
            list[node],
            Field(
                min_length=1 if reasoning else 0,
                description=(
                    meaning + " Encode fields and explicit object properties as nodes; preserve "
                    "each field's meaning, type, requirement, nullability and constraints."
                ),
            ),
        )
    }
    fields["presentation"] = (FinalPresentation | None, None)
    if reasoning:
        fields["reasoning"] = (str, Field(description="Analysis of the concrete outputs required."))
    if title:
        fields["title"] = (
            str,
            Field(
                min_length=1,
                max_length=80,
                description="A specific 2-5 word Title Case sidebar label for the top-level goal.",
            ),
        )
    return create_model("ResponseSchemaNodes", __config__=ConfigDict(extra="forbid", strict=True), **fields)


def decode_wire(value, *, internal=False, reasoning=False, title=False):
    """Validate native graph values before reconstructing canonical nested fields.

    Legacy canonical inputs do not enter this decoder. No ID, parent, order or
    constraint is silently repaired, and no depth cutoff drops model output.
    """
    if not isinstance(value, dict) or "nodes" not in value:
        return value
    model = wire_model(internal, reasoning, title).model_validate(value)
    nodes = model.nodes
    index = {node.id: node for node in nodes}
    if len(index) != len(nodes):
        raise ValueError("response schema node IDs must be unique")
    children = {}
    for node in nodes:
        if node.parent_id is not None:
            if node.parent_id not in index:
                raise ValueError("response schema node parent is missing")
            if index[node.parent_id].type not in ("object", "list[object]"):
                raise ValueError("response schema node parent is not an object")
        children.setdefault(node.parent_id, []).append(node)
        bounds_from_entries(node.type, node.constraints)
    roots = children.get(None, [])
    if reasoning and (not roots or not any(node.required for node in roots)):
        raise ValueError("response schema needs a required root field")
    for siblings in children.values():
        if len({node.name for node in siblings}) != len(siblings):
            raise ValueError("response schema sibling names must be unique")
        if sorted(node.position for node in siblings) != list(range(len(siblings))):
            raise ValueError("response schema sibling positions must be contiguous")

    # Iterative traversal rejects disconnected cycles without a schema-depth cap.
    reached = set()
    queue = list(roots)
    for node in queue:
        if node.id in reached:
            raise ValueError("response schema cycle")
        reached.add(node.id)
        queue.extend(children.get(node.id, []))
        if node.type in ("object", "list[object]") and not children.get(node.id):
            raise ValueError("response schema object needs properties")
    if len(reached) != len(nodes):
        raise ValueError("response schema cycle or disconnected node")

    output = {
        node.id: {
            "name": node.name,
            "type": node.type,
            "required": node.required,
            "nullable": node.nullable,
            "description": node.description,
            "constraints": [bound.model_dump() for bound in node.constraints],
        }
        for node in nodes
    }
    for parent, siblings in children.items():
        if parent is not None:
            output[parent]["properties"] = [
                output[node.id] for node in sorted(siblings, key=lambda node: node.position)
            ]
    result = {key: item for key, item in model.model_dump(exclude_none=True).items() if key != "nodes"}
    result["fields"] = [output[node.id] for node in sorted(roots, key=lambda node: node.position)]
    return result


def wire_json_schema(*, internal=False, reasoning=False, title=False):
    # Reuse the actual native provider conversion, including its no-reference rule.
    from providers.rose.schema import prepare_schema_for_openai

    return prepare_schema_for_openai(wire_model(internal, reasoning, title))
