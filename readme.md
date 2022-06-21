# Perl5 Debug Adapter

This debug adapter invokes **perl -d**  and handles communication with VS Code.

It has no dependencies and should work out of the box on Linux, Windows and Mac using VS Code. It also works inside **Microsofts Remote Extensions** Remote-SSH, Remote-WSL and Remote-Containers.

## Setup

### VS Code

* Install the **Perl5 Debug Adapter** extension in VS Code.
* Perl needs to be installed and the path of the **perl** executable either needs to be available inside the **$PATH** environment variable or be provided via the **launch.json** configuration file.
* **OPTIONAL** I recommend using this extension together with BSCANs Perl Navigator https://marketplace.visualstudio.com/items?itemName=bscan.perlnavigator as it provides great language server features out of the box.

### Other Editors and IDEs

As this extension implements the Debug Adapter Protocol it should be usable with other editors and IDEs https://microsoft.github.io/debug-adapter-protocol/implementors/tools/ aswell.
Feel free to try it out and report any bugs that may occur.