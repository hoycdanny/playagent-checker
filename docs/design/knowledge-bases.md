# Design: Knowledge bases

Reusable knowledge attached to tasks so the agent tests with domain context. Shared across all logged-in users. Two categories (game-genre, e.g. "Slot"; and scenario, e.g. "RTP"), each holding up to two forms of knowledge.

## Markdown knowledge

Edited directly in the web console and injected **in full** into the agent context at run time. Best for a small, certain set of facts / terminology / reading rules.

## PDF / document retrieval

Enabling "document retrieval" at creation provisions an **Amazon Bedrock Knowledge Base**:

- Embeddings: **Amazon Titan Text Embeddings v2** (1024-dim).
- Vector store: **S3 Vectors**.
- Upload PDFs/guides/specs, click **Sync** to ingest, then at run time the agent retrieves relevant snippets by task goal. Best for large reference material.

Provisioning is idempotent and exposed via `POST /knowledge-bases/{id}/provision`, so a KB created without retrieval can be upgraded later. (The API Lambda timeout was raised to accommodate provisioning; `bedrock:TagResource` is granted to the API role.)

## Selection at run time

A task may select multiple knowledge bases; a general category + a specific scenario stack. Apps can also set default knowledge bases. Built-in genre KBs are provided for all supported genres.
