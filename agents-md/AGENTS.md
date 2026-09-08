# DietCode Context Optimization

DietCode is active for this session via Codex CLI's hooks (`UserPromptSubmit`, `PostToolUse`, `PreCompact`) — intent classification, large-prompt compression, and tool-output compression all happen automatically. There is nothing to call for these; they run before your turn even starts.

## sd_retrieve

The one DietCode tool available to you. If a compacted summary marker (`[Earlier conversation — ScaleDown summary. Call sd_retrieve("<id>") ...]`) omits a specific detail you need — an exact error string, full file contents, a precise value — call `sd_retrieve` with that id to get the original verbatim text back.

## General principles

- Don't try to call `sd_compress`, `sd_summarize`, `sd_classify`, or `sd_extract` — they're not exposed as tools; the hooks already cover what they did.
- Use `sd_retrieve` only when a summary marker is missing something you actually need — not speculatively.
