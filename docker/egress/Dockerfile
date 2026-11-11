FROM alpine@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
RUN apk add --no-cache iptables iproute2
COPY start.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
