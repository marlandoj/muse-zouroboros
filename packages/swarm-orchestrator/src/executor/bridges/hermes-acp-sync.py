#!/usr/bin/env python3
"""Swarm ACP runs have no gateway turn pump: join child batches in this turn.

Only this adapter process is patched. Native delegate_task still owns pauses,
permissions, concurrency/depth limits, cancellation and child credentials.
"""
from functools import wraps


def install_foreground_delegation(module):
    original = module.delegate_task

    @wraps(original)
    def joined(*args, **kwargs):
        kwargs['background'] = False
        return original(*args, **kwargs)

    module.delegate_task = joined


def main():
    import hermes_bootstrap
    hermes_bootstrap.harden_import_path()
    from tools import delegate_tool
    install_foreground_delegation(delegate_tool)
    from hermes_cli.main import main as hermes_main
    hermes_main()


if __name__ == '__main__':
    main()
