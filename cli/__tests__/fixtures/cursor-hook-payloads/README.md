# Cursor hook payloads

Hook stdin as the Cursor IDE 3.24.18 builds it. Each payload was assembled field by field from the
IDE's own bundle (`Cursor.app/Contents/Resources/app`), not from a live session:

- `extensions/cursor-agent-exec/dist/main.js`: the Write executor sends `tool_input`
  `{file_path, content}` and the Delete executor sends `{file_path}`. An edit is a Write that
  carries the whole new file text, so the IDE has no Edit or MultiEdit tool name.
  `afterFileEdit` sends a top-level `file_path` plus `edits[{old_string, new_string}]`.
- `extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs`: the common fields
  (`session_id`, which falls back to `conversation_id`, plus `hook_event_name`, `cursor_version`,
  `workspace_roots`, `user_email` and `transcript_path`).

Ids, the email and the model are placeholders. `__WORKSPACE__` is the workspace root, and
`_cursor-payloads.mts` swaps it for the test's own root.
