FROM timberio/vector:0.55.0-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY vector-configs /etc/vector/
COPY start-fly-log-transporter.sh /usr/local/bin/start-fly-log-transporter.sh

CMD ["bash", "/usr/local/bin/start-fly-log-transporter.sh"]
ENTRYPOINT []
