# Mint a fresh workspace identity for this devbox. The snapshot carries the
# Template box's .cloud-env, and scripts/run.sh derives the Temporal task
# queue and ngrok domain from it; devboxes must never share those.
if [ -f .cloud-env ] && [ -f scripts/lib/workspace-env.sh ]; then
bash -s <<'REKEY' || echo "warning: could not re-key .cloud-env; scripts/run.sh re-keys it on a new boot"
set -eu
. scripts/lib/workspace-env.sh
port="$(cloud_env_value .cloud-env CONDUCTOR_PORT)"
write_cloud_env .cloud-env "${port:-3001}" "$(new_cloud_workspace_name)" "$PWD" "$(cloud_env_boot_id)" "$(cloud_env_agent_id)"
REKEY
fi

# Local Postgres backs the stack and the test suites.
sudo service postgresql start || true
