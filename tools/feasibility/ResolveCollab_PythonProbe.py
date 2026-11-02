# ResolveCollab feasibility: does Free 21.1 list and run Python scripts from the
# Scripts menu? (Reports disagree.) Writes hex "ok" to Fusion.prefs if it runs.
fu = resolve.Fusion()
fu.SetPrefs("Global.ResolveCollab.RCFeasPython", "6f6b")
fu.SavePrefs()
