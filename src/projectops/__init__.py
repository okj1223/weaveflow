"""Compatibility shim for the pre-rename ``projectops`` package."""

from __future__ import annotations

import weaveflow as _weaveflow
from weaveflow import *  # noqa: F401,F403

__path__ = _weaveflow.__path__
__version__ = _weaveflow.__version__
