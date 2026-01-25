# Branch Protection Setup (Optional)

If you want to prevent accidental direct pushes to master, follow these steps.

## Why Use Branch Protection?

**Without protection:**

```bash
git push origin master  # Goes straight to production
```

**With protection:**

```bash
git push origin feature-branch  # Create PR first
gh pr create
gh pr merge  # After review/checks
```

## Setup (5 minutes)

1. Go to: https://github.com/xxKeith20xx/oura-cf/settings/branches
2. Click **"Add rule"**
3. Branch name pattern: `master`
4. Enable these settings:
   - ☑️ **Require a pull request before merging**
     - Uncheck "Require approvals" (not needed for solo work)
   - ☑️ **Require status checks to pass before merging** (optional)
     - Search for: "Lint & Test" (if you want CI to block bad code)
5. Click **"Create"**

## Result

Now when you try to push directly to master:

```bash
$ git push origin master
! [remote rejected] master -> master (protected branch)
```

Instead, you'll need to:

```bash
# Create feature branch
git checkout -b fix-something
git push origin fix-something

# Create PR
gh pr create --fill

# Merge after checks pass
gh pr merge --squash
```

## Bypass Protection (Emergency)

If you need to push directly in an emergency:

1. GitHub → Settings → Branches → Edit rule
2. Temporarily delete the rule
3. Push your changes
4. Re-enable the rule

## Do You Need This?

**Use branch protection if:**

- ✅ You want forced review of changes
- ✅ You want CI checks to block bad code
- ✅ You work with others on this repo

**Skip branch protection if:**

- ✅ You're the only developer
- ✅ You trust yourself not to push bad code
- ✅ You test locally before pushing
- ✅ You want to keep workflow simple

**For this project:** It's optional. Try it if you want the safety net.
