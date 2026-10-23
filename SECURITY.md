# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this package, please report it to us.

**DO NOT** create a public GitHub issue for security vulnerabilities.

### How to Report

Email: support@revenium.io

Please include:
- Package name and version
- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if available)

We will review and respond to security reports in a timely manner.

## Security Best Practices

When using this middleware:

1. **API Keys**: Never commit API keys to version control
2. **Environment Variables**: Store sensitive configuration in `.env.local` or `.env` in the directory your process is started from. The middleware reads those two files with a built-in parser, requiring no third-party install, and never reads a `.env` from a parent directory. Real environment variables always take precedence over file values
3. **Prompt Capture**: Off by default. When enabled via `REVENIUM_CAPTURE_PROMPTS=true`, automatic PII sanitization is applied
4. **Network Security**: All connections use HTTPS
5. **Updates**: Keep the package updated to the latest version

## Data Transmission

This middleware sends the following metering data to the Revenium API:
- Provider and model used (OpenAI, Anthropic, Google, Perplexity, LiteLLM, fal.ai)
- Token counts (input, output, cache)
- Latency and streaming status
- Transaction ID for correlation
- Stop reason
- For media providers (fal.ai): media type, dimensions, duration

No conversation content is transmitted unless prompt capture is explicitly enabled. When enabled, PII is automatically sanitized before transmission.

## Additional Resources

- [Revenium Documentation](https://docs.revenium.io)
