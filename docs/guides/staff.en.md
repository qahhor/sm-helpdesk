# Smartup Hub: guide for support staff

The Smartup Hub workspace opens at the portal address, section `/agent`. Button and section names below are written as the portal shows them. Rights depend on the role: first line, second line, Customer Care, product, administrator. What your role cannot do is not on the screen.

## 1. First sign-in and the second factor

1. The administrator sends an invitation by email. Open the link (it works for 24 hours), on the «Set your password» page fill in «Password» and «Password again» and press «Save password». The password is at least 12 characters, the portal does not accept common passwords.
2. Sign in on the «Staff sign-in» page: «Email», «Password», «Sign in».
3. On the first sign-in the portal shows «Set up the second factor»: scan the QR code with an authenticator app (Google Authenticator, Aegis or another), enter «Code from the app» and press «Confirm».
4. After that every sign-in takes the password and a code from the app. A session lasts 12 hours and is not extended. After five wrong codes the check closes for 15 minutes.

To change the password: user menu, «Sessions», block «Password», button «Change password». After the change all sessions end, sign in again. Lost the phone with codes: the administrator resets your access and you get a new link.

## 2. Queues

«Queues» groups requests by answer deadline:

| Queue | What is in it |
|---|---|
| «New» | Requests without an assignee |
| «Mine» | Your requests |
| «Second line» | Handed over to the second line |
| «Waiting for client» | Waiting for the client, the deadline is paused |
| «In development» | Handed over to development |
| «Overdue» | The answer or resolution deadline is breached |
| «All» | All requests with filters |

«Search» looks up a number, text, organization, tax number and author. Open a request and press «Take it» to take it.

## 3. Reply to the client and internal note

1. In «Where to write» choose «Reply to client» or «Internal note». The client never sees a note.
2. The «Template» button or `/` with a template code at the start of a line inserts a prepared text.
3. Tick «Waiting for the client» if work cannot go on without the client's answer: the request moves to waiting and the deadline pauses.
4. Press «Send» (for a note «Save note»). If the client answered or the status changed while you were writing, the portal shows the changes and the button «Send anyway».

The draft is saved by itself: the line «Draft saved».

Status, priority, type and module change in the actions block on the right: «Change status», «Change priority». When closing a request choose «Outcome». «Snooze» hides the request until the chosen time. Tags: «Add a tag». A duplicate is closed with «Merge into main».

## 4. Hotkeys

| Keys | Action |
|---|---|
| `?` | «This help» |
| `F2` or `Ctrl+K` | «Command palette» |
| `R` | «Reply to client» |
| `N` | «Internal note» |
| `T` | «Take it» |
| `S` | «Snooze» |
| `Ctrl+Enter` | «Send» |
| `Ctrl+Shift+Enter` | «Send and next» |
| Up and down arrows | «Previous ticket», «Next ticket» |
| `F7` | «Refresh list» |

In the command palette you can type a request number and open it at once.

## 5. Second line and development

**Handing over to the second line.** Press «Transfer to the second line». The dialog shows the first line playbook for the module and type of the request: go through its items. Choose «Reason», fill in «What was already checked» and «What the second line needs to do» and press «Transfer to second». The deadline towards the client does not change. All playbooks: «First-line playbooks».

**Handing over to development.** Press «Hand over to development», enter «Task number» and «Task link» from the task manager and press «Hand over». The request gets the status «In development», the task status is shown in «Development task». When the fix is released, close the request with «Fixed in version» and the version number.

## 6. Solutions and publishing

1. «Solutions»: «My tasks» (your drafts and solutions under review) and «All solutions».
2. A new solution: «New solution», then «Create». From a request: «Publish as a solution».
3. The editor saves by itself («All changes saved»). Write the steps so that a client can repeat them without support.
4. On the right is «Ready to publish»: title, module, at least one step, the text check. If the check found a phone, tax number or server address, remove it or mark that it is not client data.
5. Press «Publish». Clients see only the published version. Check the Uzbek and English translations before publishing in those languages.

## 7. Ideas: moderation and the monthly pick

«Ideas» (the product and administrator roles moderate).

1. The «Moderation» tab: new client ideas, oldest first. Open an idea and check the text. If it contains client data, edit the text and press «Save changes».
2. «Publish» opens the idea for voting. If the portal found a phone or a tax number in the text, first tick «Checked: no client data in the text».
3. A repeat: «Merge» with the number of the main idea, the votes move there. A refusal: «Decline» with a reason the author will see.
4. The «Comments in review» tab: comments the portal held because of data in the text.
5. The «Votes by organization» block shows organizations without voter names.

**Monthly pick.** On the 1st at 09:00 Tashkent time the portal gathers the top five. On the «Monthly selection» page choose «Idea of the month», write the explanation in three languages and press «Pick the idea of the month». A machine draft of the explanation must be read and marked «Text checked».

## 8. Rules and macros

**Automation rules** (administrator): menu «All settings», section «Automation rules». A rule reads as a sentence: when an event happens, if the conditions hold, then do the actions.

1. «New rule», set «Rule name» and «Event».
2. Add «Condition» and «Action».
3. «Start dry run» shows which recent requests the rule would match. The dry run changes nothing.
4. «Save», then «Turn on» in the list.

The three preset rules (P1 message to the on-call staff, breached deadline, low rating) cannot be deleted, they can be adjusted.

**Macros**: section «Macros», button «New macro». On a request page a macro runs from the «Macros» menu. If the request changed while the page was open, the macro does nothing and the page says what changed.

## 9. Metrics

«Metrics»: first response and resolution time, the share solved on time, ratings. «Period»: «7 days», «30 days», «90 days» or «Custom period». The «CSV export» block exports slices as CSV files, every export is written to the audit log.

## 10. Administrator settings

Menu «All settings». Changing settings needs a sign-in within the last 15 minutes: if you signed in earlier, the portal asks you to sign in again.

| Section | What is set there |
|---|---|
| «Staff» | «Invite a staff member», role, line lead, blocking and access reset |
| «Smartup servers» | Servers clients sign in through, and widget settings |
| «Targets and working hours» | Deadlines by priority, the weekly schedule, holidays |
| «Reply templates» | Templates in three languages: «Add template» |
| «Tags» | Tag names and colors |
| «Notifications and email» | Support addresses, on-call staff, the on-call bot |
| «Webhooks» | Addresses for request events |
| «Solutions» | Domains solutions may link to |
| «Audit log» | Who changed what and when |

The pilot reference data (modules, holidays, templates, playbooks, staff) is loaded on the server with `hub seed:pilot`: see `docs/runbooks/launch.md`.

## 11. AI assistant

Tez replies first to requests from the portal, the widget and emails of identified clients, if AI processing of the organization and the assistant are on.

Customer Care and the administrator turn on AI processing on the organization card, block «AI handling», and only after the client's written consent: fill in «Consent date» and «Basis» (letter or contract number) and press «Turn on AI processing». A new organization that signs in through Smartup for the first time works without AI until consent is recorded. If the client declines, press «Turn off AI processing»: the consent record is kept, both actions are in the audit log. Requests handed over by the assistant are in the «After AI» queue with the handoff reason and also in New. The queue «AI replied, client silent» shows where the client has not pressed a button under the answer yet.

On the right of the request card is the AI assistant block: the handoff reason, the number of replies, the summary marked «AI, not verified» next to the original text, the solutions found with scores and triage suggestions. A request field changes only with «Accept» or «Accept all». Mark a wrong assistant answer with «Mark the answer as wrong» under its message: it goes to «AI answer review». A client message in another language can be translated with «Translate»: only staff see the translation, and it is not a basis for actions with rights, data or payments.

## 12. Known problems, announcements and candidates

**Known problem.** A request has a "Known problem" block: "Create known problem" (second line, Customer Care, administrator) carries over the internal title, module and signature and links the request; the public text is written separately on the card, and the client's subject is never copied into it. Any staff member who works on requests can link a request: in the request block, in bulk from the queue (up to 100) or by a rule. New requests with the same error are linked automatically by signature. Showing to clients is enabled only with public text free of phones, emails, TINs and organization names.

**Broadcast and closing.** "Write an update to everyone" on the card: text in your language, machine translations to recipients' languages that you accept or edit, and the number of requests and organizations. Each recipient gets exactly one message, email and Telegram notice. "Close problem" requires a final text and moves open linked requests to "Resolved"; if the problem has a development task with a version, the resolution is "Fixed in version". The development task is linked in the "Development task" block on the card; when its status changes, the problem owner gets a notification to update the problem status.

**Tez and the problem.** If a request is linked to a shown active problem, Tez replies with its public description without calling the model and hands the request to "After AI" with the reason "known problem". During an "outage" announcement Tez reports the outage and hands the request over with the reason "outage in progress".

**Announcements** (Customer Care, administrator): "Announcements" in the "Clients" group: kind, period of up to 90 days (Tashkent time), audience (everyone, Smartup server, module), text and accepted translations, ending early.

**Solution candidates.** "Candidates" in the "Knowledge" group: solution drafts that AI prepared from closed requests without a solution; similar ones are merged, candidates with more requests and organizations come first. Clients do not see them and suggestions do not find them. On the card: "Turn into a solution draft" (an internal solution with all source requests), "Merge with a solution" by number, "Reject" with a reason. A solution from a candidate is published the usual way, but every "phone", "email", "command" and "code" finding must be checked; editing the text clears the checks. Candidate settings (switch, daily limit, merge thresholds) are on the administrator's "AI assistant" page.

## 13. AI staff

The AI staff (Hermes Agent and other internal agents) works with the portal only through the MCP server with a token that the administrator issues in «AI staff». The agent reads requests of organizations with AI processing on, without names, email, phone numbers and organization names, and writes only what staff see. Clients never see its records.

**Mark.** Every agent record carries the mark «AI staff, not verified» and is shown as plain text, without formatting and active links. It is material for you, not a ready answer: check it before you act.

**Notes and the second line memo.** An agent note sits in the request timeline among internal notes; it does not change the status, deadlines or assignee and sends no notifications. A memo for the second line appears in the «Transfer to the second line» window as «AI staff memo draft»: it does not fill the transfer fields, write them yourself.

**Solution drafts.** A solution draft from the agent is internal and has untrusted text: it is published the usual way, and each finding must be marked as checked. If the agent proposes a change to a published solution, the draft links to it; the solution itself does not change.

**Known problem drafts.** A problem draft (status «AI staff draft») is not shown to clients, its signature is not in effect and requests are only proposed. The second line, Customer Care and the administrator press «Accept draft», then «Link proposed»; an unneeded draft is closed with «Reject draft».

**Signature spikes.** The «Known problems» page has the «Signature spikes» block: one error in requests of several organizations within a short time. «Create known problem» works without the agent too. The administrator sets the threshold and window on the «AI assistant» page in the «Signature spike» block.

**Digests.** The «Digests» section in the «Analytics» group: morning digests and other agent materials. Open a digest and press «Reviewed» once you have checked it. If the administrator set the team chat, the portal posts a short message with numbers and request numbers there; the agent's text never goes to the chat.

## 14. Code knowledge

Once a week the AI staff member reviews the Smartup code and sends conclusions: which errors exist, when they happen and what to check. The portal holds no code: the place in the code is only a reference (object, file, line). Clients, the AI assistant and suggestions never see these conclusions. «Code knowledge» in the «Knowledge» group is visible to the second line, Customer Care and the administrator.

**Approval queue.** New and changed entries arrive as drafts and are highlighted. Open an entry, check the message template, the conditions and what to check, then press «Approve» or «Reject». «Edit» changes the texts and the template; the template is plain text with placeholders in curly braces, without regular expressions. If an entry changes in the next scan, it becomes a draft again.

**Exact signature.** An approved template recognizes the error in new requests: the entry key becomes the request signature. Solutions and known problems with this signature are found automatically.

**In a request.** The block «What the code tells» in the right column shows when the error happens, what to check and the place in the code. Entries not approved yet are marked «not verified». The first line sees only «What to check:» of approved entries. «Create a solution from the entry» makes a solution draft for clients without internal names; check it and publish it the usual way.

**Analyze by code.** «Analyze by code» passes the request to the AI staff member without client contacts. In a few minutes an internal note appears in the conversation with the marks «AI staff, not verified» and «Code analysis»: a hypothesis of the cause, the place in the code, what to check with the client. If the agent does not answer within 10 minutes, the block says the analysis is not done: work with the request as usual. Answer the client in your own words. The first line does not see this note. The administrator can start the analysis with a rule action «Ask for a code analysis».

**History and module map.** «Scan history» shows the date, the code version and the numbers of new, changed and gone errors, and the reasons for a rejected report. «Module map» suggests updates to the module list; the administrator presses «Apply to the module list».
