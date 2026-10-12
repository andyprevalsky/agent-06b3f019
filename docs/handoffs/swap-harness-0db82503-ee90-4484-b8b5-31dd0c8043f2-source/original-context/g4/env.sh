cd /home/boxes/rose
export ROSE_USE_SYSTEM_PG=true; source .cloud-env
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export PATH="$HOME/.fly/bin:/home/boxes/rose/agents/venv/bin:$PATH"
