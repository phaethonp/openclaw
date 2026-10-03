# Urbicana Amazon Bedrock Provider

Official Urbicana provider plugin for Amazon Bedrock. It adds Bedrock model discovery, text generation, embeddings, and guardrail-aware provider routing for agents that use AWS-hosted models.

Install from Urbicana:

```bash
openclaw plugins install @openclaw/amazon-bedrock-provider
```

Configure AWS credentials and region through your normal Urbicana credential/profile setup, then select Bedrock models with the `amazon-bedrock/...` provider prefix.
