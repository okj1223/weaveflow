# Discord OpenClaw Weaveflow POC

This note records the successful Discord -> OpenClaw -> Weaveflow proof of
concept.

Discord was able to invoke the OpenClaw-exposed `weaveflow_stdio_poc` tool. The
tool created a Weaveflow task, completed the confirmation step, listed the task,
and returned a success result to Discord.

Observed successful flow:

```text
Discord message
-> OpenClaw Discord session
-> weaveflow_stdio_poc
-> Weaveflow stdio bridge
-> create Weaveflow task
-> confirm task creation
-> list created task
-> return success to Discord
```

Successful result included:

```text
Weaveflow stdio POC: ok
create_task=ok
pending_confirmation=yes
confirmation_completed=yes
task_list_seen=yes
task_id=TASK-0001
```

Important input note: `taskText` must clearly express create-task intent. A bare
title-like phrase can reach `weaveflow_stdio_poc` but fail intent mapping; use
explicit wording such as `Create a task titled Discord OpenClaw Weaveflow POC
task`.
