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
