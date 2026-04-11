## 2.0.0
* Add socket transport support for perl5db and child fork runtimes
* Make socket transport the default debugger transport
* Keep stdio transport available as an explicit launch option
* Restrict unsupported fork-session termination guard to stdio transport
* Improve startup breakpoint handling for breakpoints selected before launch
* Improve multi-file prelaunch breakpoint behavior by deferring non-main-script breakpoints until source load
* Improve Windows path error handling when changing file context in perl5db
* Add lazy loading for nested variables in the debug view (expand-on-demand)
* Add chunked display for large arrays/hashes using maxArrayElements and maxHashElements as chunk size
* Keep large array/hash chunk references stable and expandable for very large collections
* Improve hash chunk ordering by using numeric-aware key sorting when keys are numeric
* Improve setVariable reliability for nested and chunked variables by reusing/reloading evaluateName expressions
* Fix stale variable values after setVariable by refreshing cached container state
* Add a safety cap to variable dump retries to prevent unbounded continue loops on malformed debugger output
* Improve shutdown reliability by terminating detached perl process trees to avoid dangling runtimes after repeated sessions
* Add regression tests for prelaunch breakpoints, stop-on-entry ordering, transport behavior, and perl5db path-error handling

## 1.0.0
* Step in, step out, step over, restart, terminate
* Set breakpoints in any script or module
* Show stack trace
* List all local, global and special variables
* Hover and watch variables
* Copy variable expressions from UI
* List loaded sources
* Change the value of any variable
* Show inline values while debugging
* Commands and buttons to run and debug a perl script
* Add or overwrite environment variables via launch.json
## 1.0.1
* Fix running state UI on Linux
## 1.0.2
* Fix stacktrace for imported modules and eval statements
## 1.0.3
* Change PERL5DB-Options via launch.json
* Pause request
## 1.0.4
* Fixed issue #3
## 1.0.5
* Improvements for bundling the debug-adapter.
## 1.0.6
* Read from &lt;STDIN&gt;
## 1.0.7
* Fix regular expression providing inline values
## 1.0.8
* Disable buffering of output sent to STDOUT
* Fix error handling when parsing variables
## 1.0.9
* Add option maxArrayElements
* Add option maxHashElements
* Add option sortKeys
## 1.0.10
* Add option to deepcopy before parsing a variable
* Fix inline variables showing for comments
## 1.0.11
* Improve compatibility with older versions of Perl/DataDumper
* Improve logging
## 1.0.12
* Improve compatibility with older versions of Perl (Issue#21)