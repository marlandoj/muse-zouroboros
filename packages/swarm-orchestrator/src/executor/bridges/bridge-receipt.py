#!/usr/bin/env python3
"""Emit a typed bridge receipt; keep selection evidence distinct from billing proof."""
import json, os, pathlib, sys


def parse_pi(text):
    messages = []
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if event.get('type') == 'message_end':
            message = event.get('message', {})
            if message.get('role') == 'assistant':
                messages.append(message)
    if not messages:
        raise ValueError('Pi returned no completed assistant message metadata')
    message = messages[-1]
    if message.get('stopReason') in ('error', 'aborted'):
        raise ValueError('Pi assistant failed: ' + str(message.get('errorMessage', message['stopReason'])))
    model, provider = message.get('model'), message.get('provider')
    if not model or not provider:
        raise ValueError('Pi completed without provider/model metadata')
    output = '\n'.join(part.get('text', '') for part in message.get('content', []) if part.get('type') == 'text')
    if not output.strip():
        raise ValueError('Pi completed without final response text')
    return output, provider + '/' + model, provider


def main():
    kind, output_file, selected = sys.argv[1:4]
    text = pathlib.Path(output_file).read_text()
    if kind == 'pi':
        try:
            output, model, provider = parse_pi(text)
        except ValueError:
            if os.environ.get('RESULT_PATH'):
                raise
            # Compatibility for direct CLI/mock invocations without a receipt consumer.
            print(text, end='')
            return
        provenance = {'harness':'pi', 'resolvedModel':model, 'servingProvider':provider, 'selectionEvidence':'provider-response'}
    elif kind == 'kimi':
        output, model = text, selected
        if not output.strip():
            raise ValueError('Kimi returned no response text')
        provenance = {'harness':'kimi', 'resolvedModel':model, 'selectionEvidence':'cli-argument'}
    else:
        raise ValueError('Unsupported bridge')
    provenance['requestedModel'] = selected
    result = {'task':{'id':os.environ.get('SWARM_TASK_ID','bridge'),'task':'Native bridge result','persona':os.environ.get('SWARM_PERSONA') or kind,'priority':'medium'},'success':True,'output':output,'durationMs':0,'retries':0,'modelUsed':model,'modelProvenance':provenance}
    if os.environ.get('RESULT_PATH'):
        path = pathlib.Path(os.environ['RESULT_PATH'])
        staged = path.with_name(path.name + '.pending')
        staged.write_text(json.dumps(result))
        staged.replace(path)
    print(output, end='' if output.endswith('\n') else '\n')


if __name__ == '__main__':
    main()
