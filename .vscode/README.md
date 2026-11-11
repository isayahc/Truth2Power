# Debug locally in VS Code

1. Open the repository folder in VS Code.
2. Stop any existing `npm run dev` and `npm run audit:worker` processes first.
3. Open **Run and Debug**, select **Truth2Power: full stack**, and press **F5**.

This launches the combined Vite/API server and audit worker in separate terminals
on port **5180**, then opens Chrome with frontend debugging once the server is
ready. Stopping the compound stops both Node sessions. Chrome must be installed;
the Node and Chrome debuggers are built into VS Code.

Set breakpoints in `frontend/src/`, `backend/src/`, or `backend/audit/`.
Select the appropriate session in the debug toolbar when multiple sessions are
active. For caught pipeline errors, enable **Caught Exceptions** in the
Breakpoints panel. Python child processes run normally; these configurations
do not attach a Python debugger.

Individual app, worker, and browser-only configurations are also available.
Use the browser-only configuration when the server is already running.

Both Node sessions use the existing `.audit/` history and evidence. Starting the
worker processes queued jobs. Run only one worker while stepping through code:
long breakpoint pauses can outlast job leases or request timeouts.

Windows uses `.venv/Scripts/python.exe` and the installed certifi CA bundle.
Linux/macOS uses `.venv/bin/python` and inherits `SSL_CERT_FILE`; set it to your
installed CA bundle if needed before opening VS Code. Model settings and
credentials are inherited from VS Code's environment; set them before launching
VS Code if model review is needed. Do not put credentials in `launch.json`.
