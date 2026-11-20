# Pitch script for the mentor evaluation (3 to 5 minutes) and likely questions

Say only what is true today. Numbers marked (measured) come from our own runs; say "small test" for any evaluation.

## The 4-minute pitch

**0:00 The problem (30 s)**
"When you save a Reel, your mind makes a decision for your future self: *I need this*, *it's an idea*, *I'll try it*. Almost always that decision is gone by the time you could use it, and your saved pile can't tell you what it was for. The saving effort was wasted. You can't reach what you meant."

**0:30 The idea (30 s)**
"Neophi keeps the decision. You send a Reel to Neophi on Instagram, like you'd send it to a friend, and say why if you like. The message is optional; the save works without it. Your words stay exactly as you typed them and come first. The AI's reading is separate, labelled, and shows its evidence or says it isn't sure."

**1:00 Live demo (2 min). Open the prototype on a phone-width window**
1. "Connect once": tap Connect Instagram, show the one-time code, send it to the Neophi account (or, for anyone without an approved tester account, the **Try without Instagram** button; it is clearly labelled simulated). The page says connected by itself.
2. "Share a Reel with a few words": it arrives with your words first. Point at the AI reading: labelled AI, with the useful points.
3. "Journey": open it. "This is the one place that shows everything you ever saved, as a tree that grows by itself: branches from your categories, topics, then your saves. New growth is marked." Open one save: four sections, your words kept exactly.
4. "Search in Hinglish" for one half-remembered thing; it comes back first.
5. Settings: "Export everything. Delete everything. Private saves never reach an AI model."

**3:00 Why it's different (30 s)**
"Bookmarks store the post. We store the decision. Summarisers describe content; we never invent why you saved it. And Journey replaces the long list and big folders that make saved posts unusable."

**3:30 How it's built and what's next (30 s)**
"All on Google Cloud: Cloud Run, Firestore, Firebase Auth, Cloud Storage, Scheduler, Secret Manager, and Gemini on Vertex AI. Next: **Check this Reel**, where you send a Reel only to verify it and Neophi replies in the same chat with a plain verdict and sources, and affiliate income for saves that are products or places."

## Likely questions, with honest answers

- **Can anyone use the Instagram connection today?** Only approved tester accounts, because the Meta app is in development mode until Meta approves it. That is why we built a clearly labelled simulated share, so anyone can experience the same journey. We say this openly.
- **Does it watch the video?** For a shared Reel, Meta currently sends the link and caption, not the video; the reading uses the caption (and your words) and says so. A video sent as a file is read from the video itself (the larger-file path is raised to 50 MB; we have not exercised it with a real file yet).
- **What if the caption is just hashtags?** The reading decides whether a caption is informative, mixed or noise, uses it only when it carries real information, and says when it ignored it. [Say this only if PR #22 is deployed.]
- **How do you stop the AI making things up?** Every AI claim cites evidence from the save or says it is not sure; the reading never writes your reason; saves you mark private never reach a model; AI text is always labelled.
- **What does it cost?** About half a US cent per analysed save on the model we use (measured on a small test; re-check current prices). 300 saves a month is about $1.57.
- **How accurate is it?** We have only small tests: the whole journey passes 18 of 18 automated checks on the deployed service, and a small synthetic set of 22 captions across Reel types showed [numbers from docs/BENCHMARKS.md]. We call it a small test, not a benchmark.
- **Privacy and data?** Saves are in Firestore and Cloud Storage in Google's Mumbai region; anonymous sign-in; export and delete everything in one tap, which also removes the Instagram link and queued messages; privacy, terms and data-deletion pages are live.
- **How will it make money?** Free analysed saves each month; a personal plan; a creator plan; affiliate income on saves that are products or places, shown apart from the person's words and the AI's reading; later, paid checks for "Check this Reel". Nothing priced until cost per save is measured with real users.
- **What about fake or misleading Reels?** That is the next feature, **Check this Reel**: it will say what holds up, what doesn't, and what it couldn't check, with sources; it will never accuse a person or claim certainty. It needs Meta's messaging permission and a small evaluation before we claim anything publicly.
- **Why would anyone come back?** Because Neophi holds something they already meant to use: their own reason, one place to see it all (Journey), Today brings back saves when they are useful. No streaks, no fake urgency.
