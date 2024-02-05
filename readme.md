# Perl Debug Adapter

This debug adapter invokes **perl -d**  and handles communication with VS Code.

It should work out of the box on Linux, Windows and Mac using VS Code. It also works inside [**Microsofts Remote Extensions**](https://code.visualstudio.com/docs/remote/remote-overview) [Remote-SSH, Remote-WSL and Remote-Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.vscode-remote-extensionpack).

## Setup

### VS Code

* Install the **Perl5 Debug Adapter** extension in VS Code.
* Perl needs to be installed and the path of the **perl** executable either needs to be available inside the **$PATH** environment variable or be provided via the **launch.json** configuration file.
* The PadWalker module needs to be available in your environment.
* **OPTIONAL** I recommend using this extension together with BSCANs [Perl Navigator](https://marketplace.visualstudio.com/items?itemName=bscan.perlnavigator) as it provides great language server features out of the box.

### Other Editors and IDEs


* [NVIM](https://github.com/mfussenegger/nvim-dap/wiki/Debug-Adapter-installation#perl-debug-adapter)

As this extension implements the Debug Adapter Protocol it should be usable with [other editors and IDEs](https://microsoft.github.io/debug-adapter-protocol/implementors/tools/) aswell.
Feel free to try it out and report any bugs that may occur.