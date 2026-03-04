from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Any, Optional

@dataclass
class OuterPlan:
    refs: Dict[str, Any]

@dataclass
class InnerAction:
    u: Dict[str, float]
    info: Optional[Dict[str, Any]] = None
