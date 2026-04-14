"""Re-export shim -- real implementation lives in domains/enable_write_permissions/."""

from domains.enable_write_permissions.handler import (  # noqa: F401
    EnableWritePermissionsManager,
    enable_write_permissions,
    get_manager,
)
