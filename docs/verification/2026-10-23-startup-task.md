# Native startup-task helper verification

`scripts/verify/startup-task-windows.ps1` exercised the existing production
`startup-task.ps1` helper through the real Windows ScheduledTasks provider. It
created a uniquely named temporary task, disabled it before inspection, queried
it, exported the scheduler XML and removed it. Eight checks passed.

The real task action preserves the quoted disposable launcher path. Its
principal uses limited interactive user permissions and its trigger is a user
logon trigger. If a login occurred during the brief test, the launcher could
only run with disposable state, port 0 and Dry Run; the test did not trigger
the task or claim an actual Windows login.

The pre-existing `Selbstlauf Continuation Watchdog` task XML was unchanged.
The actual user configuration SHA-256 before and after was
`B9423F6297145F859CBA41845D80AE20D25208524B286F378A358082AF46229C`.
The temporary task was absent after deletion. The evidence is in
`tmp/settings-verification-20261022/startup-task/result.json` and
`temporary-task.xml`; the conda Node 22.23.2 orchestration log is
`environment/startup-task-windows.log`.

This is scheduler integration evidence. Startup/tray settings UI screenshots
and real native close/terminal actions are recorded in the desktop settings
report. No application, dependency or CLI version was upgraded.
