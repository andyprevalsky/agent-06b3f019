"""Fresh-browser realms for a declared live authentication benchmark."""


def fresh_auth_realms(task) -> tuple[str, ...]:
    primary = task.browser_auth_realm
    declared = (task.environment or {}).get('fresh_auth_realms')
    if declared is None:
        return (primary,)
    if (not isinstance(declared, list) or not declared or primary not in declared
            or len(declared) != len(set(declared))
            or any(not isinstance(realm, str) or not realm or '/' in realm or ':' in realm for realm in declared)):
        raise ValueError('Invalid fresh authentication realms')
    return tuple(declared)
