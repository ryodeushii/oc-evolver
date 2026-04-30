Use the oc-evolver plugin to create a reusable command named `review-markdown`.
Its frontmatter description should be `First review flow`.
Its body should say `Review README.md once.`
Stop after the command exists.
---
Update the existing `review-markdown` command so its frontmatter description is `Second review flow`.
Its body should say `Review README.md twice.`
Stop after the updated command exists.
---
Use the oc-evolver plugin rollback tool to restore the previous accepted revision, then stop.
