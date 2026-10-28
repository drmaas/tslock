---
'@tslock/cloudflare-do': patch
---

Unlock and extend a Durable Object lock only when the caller sends the token from that acquire. `lockedBy` is stored as a hostname label. A record with no token is left unchanged until it expires. Deploy the Durable Object class and the client together.
