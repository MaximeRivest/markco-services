# Goals and Non-Goals

This document captures current project intent for the platform and MRMD ecosystem direction.

## Vision (founder statement)

> I think a team of one can now create a software masterpiece as a hobby on nights and weekends.
>
> I have often told myself I should stop adding features to MRMD and just ship. I decided to stop thinking like that.
>
> I want to build a masterpiece.
>
> I want to build the literate programming, scientific computing, reproducible research, academic writing/publishing tool that has none of the annoyances I felt in the last 10 years. I want the best parts of Orgmode, R Markdown, Overleaf, RStudio, VS Code, Databricks, JupyterHub, Quarto, Observable, Pluto.jl and more.
>
> I am not here to make a product. I am here to make a tool — my tool, the tool.
>
> It should work from my phone, any browser, Kindles and e-paper tablets. Notes and writing available anywhere. Any compute attachable to any cell. Live collaboration. Publish to the open web with one action. AI commands that help thinking/exploration without making me lazy or shallow.
>
> Any notebook format should be drag-and-droppable into markdown. PDF should become markdown. Context should be recursively bindable to AI calls. REPL runtimes should move to other compute in seconds. Teams of 100 should query the same 1 TB RAM dataset fast. JS/CSS/HTML should be excellent for data science and interactive storytelling. Voice input/output should be first-class. Markdown tables should be reproducible and more powerful than spreadsheet workflows while still AI-reasonable. R/Python/Julia data sharing should approach zero-copy.
>
> I will do this slowly, with love, as a hobby, without stress and deadlines, using AI coding tools with careful review and understanding.

## Platform goals (current)

1. **Reliable anywhere access**
   - authenticated browser access to personal editor environment
   - robust reverse proxy for HTTP + WebSocket paths
2. **Compute elasticity without UX breakage**
   - runtime snapshot/migrate/restore while preserving editor continuity
3. **Collaboration and publishing**
   - real-time editing and one-step web publishing paths
4. **AI-native but deep-work friendly**
   - AI supports reasoning/exploration without taking over the workflow
5. **Format interoperability**
   - markdown as canonical document model with import/convert bridges

## Non-goals (for now)

- strict deadline-driven roadmap optimization over craftsmanship
- enterprise multi-tenant policy/compliance surface before core UX quality
- premature abstraction if it hurts directness and hackability

## Decision filter

When evaluating features/architecture changes, ask:

- Does this reduce long-term friction in research/writing/collaboration?
- Does this preserve markdown-first, reproducible workflows?
- Does this keep the tool usable from lightweight clients (phone/tablet/e-paper/browser)?
- Does this improve depth of thought rather than shallow automation?
