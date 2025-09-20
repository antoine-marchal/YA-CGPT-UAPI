# Project Architecture Diagram

Below is a **high-level Mermaid.js diagram** representing the structure and main data flow for this app.

```mermaid
flowchart TD
  subgraph Server/API
    A[Express API<br/>src/index.js]
  end

  subgraph Services
    B[ChatGPT Service<br/>src/services/chatgptService.js]
    C[Session Service<br/>src/services/sessionService.js]
  end

  subgraph Automation
    D[ChatGPT Listener<br/>src/chatgptlistener.js]
  end

  subgraph Utilities
    E[Mutex Utility<br/>src/utils/mutex.js]
  end

  A -->|uses| B
  B -->|calls| D
  B -->|uses| E
  A -->|may use| C
```

**Legend:**
- **A**: Main Express server (entry point, API routes, message handling)
- **B**: Service layer for ChatGPT operations (calls Playwright via D)
- **C**: Session management utilities
- **D**: Playwright browser automation for ChatGPT interactions
- **E**: Utility for concurrency/mutex logic

> This diagram shows how API calls received by the Express server flow through the ChatGPT service, which leverages browser automation, with utilities supporting concurrency and session state.
