# Logging in this project

Never use console.log/error/warn in production code. Use the logging utilities from `@/utils/error-handling`.

# API Requests

NEVER use raw fetch() for API requests to Tinfoil enclaves. Always use the TinfoilAI SDK client (via getTinfoilClient or getWebSearchClient). The SDK handles attestation verification which is critical for security.

# Error Classification

NEVER string match on error messages to drive control flow (retries, fallbacks, recovery). Messages vary across browsers, SDK versions, and locales. Classify errors with structured signals instead: error classes (instanceof, e.g. the OpenAI SDK's APIConnectionError), spec-defined error names (DOMException "AbortError"), error codes, and HTTP status codes.
