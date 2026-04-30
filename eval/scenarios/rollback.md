Use the oc-evolver plugin to create a reusable command named `review-markdown`.
Its frontmatter description should be `First review flow`.
Its body should say `Review README.md once.`
Promote the pending revision after the command exists, then stop.
---
Update the existing `review-markdown` command so its frontmatter description is `Second review flow`.
Its body should say `Review README.md twice.`
Promote the pending revision after the updated command exists, then stop.
---
Use the oc-evolver plugin rollback tool to restore the previous accepted revision, then stop.
