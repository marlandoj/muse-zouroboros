"""Per-harness prompt events in, per-harness context injection out.

Formats were read from the installed harnesses on 2026-09-23 (claude 2.1.280, codex 0.156,
kimi 0.41, gemini 0.58, opencode 1.18.29, pi 0.85, hermes 0.16):

  claude, codex  UserPromptSubmit; stdin .prompt; out hookSpecificOutput.additionalContext
  gemini         BeforeAgent; stdin .prompt; out hookSpecificOutput.additionalContext
                 (plain stdout becomes a user-visible systemMessage, so the no-op is {})
  kimi           UserPromptSubmit; stdin .prompt (a list of content parts); out {"message": ...}. Any other stdout,
                 including {}, is injected verbatim, so the no-op is empty output.
  opencode, pi, hermes
                 plugins in plugins/ send {"prompt", "session_id", "cwd"} and inject stdout
                 as plain text; the no-op is empty output.
  factory       not a harness hook. The Zouroboros Software Factory calls this engine directly
                 from its ACP transport, so there is no event wrapper and no hook envelope;
                 render is plain text for a possible future live mode and the no-op is empty
                 output. It is a distinct label so factory-dispatched prompts stay separable
                 from operator CLI prompts in the log and in `report`.
"""
import json

HARNESSES = {
    'claude': {'events': ['UserPromptSubmit'], 'noop': '{}'},
    'codex': {'events': ['UserPromptSubmit'], 'noop': '{}'},
    'gemini': {'events': ['BeforeAgent'], 'noop': '{}'},
    'kimi': {'events': ['UserPromptSubmit'], 'noop': ''},
    'opencode': {'events': ['chat.message'], 'noop': ''},
    'pi': {'events': ['before_agent_start'], 'noop': ''},
    'hermes': {'events': ['pre_llm_call'], 'noop': ''},
    'factory': {'events': [], 'noop': ''},
}


def _str(value):
    return value if isinstance(value, str) else ''


def _text(value):
    """A prompt as a string, or as content parts (kimi sends [{"type": "text", "text": ...}])."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return _str(value.get('text'))
    if isinstance(value, list):
        return '\n'.join(t for t in (_text(v) for v in value) if t)
    return ''


def normalize(harness, event):
    if harness not in HARNESSES:
        raise ValueError('unknown harness: ' + str(harness))
    event = event if isinstance(event, dict) else {}
    prompt = _text(event.get('prompt'))
    if not prompt and harness == 'hermes':
        extra = event.get('extra') if isinstance(event.get('extra'), dict) else {}
        prompt = _text(extra.get('user_message'))
    session = _str(event.get('session_id')) or 'unknown'
    return {'prompt': prompt, 'session_id': f'{harness}-{session}', 'cwd': _str(event.get('cwd'))}


def render(harness, text):
    spec = HARNESSES[harness]
    if not text:
        return spec['noop']
    if harness in ('claude', 'codex', 'gemini'):
        return json.dumps({'hookSpecificOutput': {'hookEventName': spec['events'][0], 'additionalContext': text}})
    if harness == 'kimi':
        return json.dumps({'message': text})
    return text


def is_hook(harness):
    """True when the harness delivers a hook envelope, False when it consumes plain text.

    Only hook harnesses can have `events` read for a hookEventName; a direct caller
    (factory) has none and must never be rendered as a hook response.
    """
    return bool(HARNESSES[harness]['events'])
