# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend/e2e/sso.spec.ts >> SSO SAML login screen >> bypasses SSO and shows the WLC login when SAML is not configured (404)
- Location: frontend/e2e/sso.spec.ts:1009:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

```
Error: Channel closed
```