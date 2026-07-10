from benchmarks.fleet_startup_phase import current_phase, startup_state


def test_current_phase_progression():
    assert current_phase("") == "cloning"
    assert current_phase("▶️  Starting warm machine abc ...") == "provisioning"
    assert current_phase("Starting warm machine\n✅ Machine started + ssh-ready (abc)") == "staging"
    assert current_phase("...ssh-ready...\n✅ On-box driver launched + confirmed running.") == "booting"


def test_startup_state_active_and_done_durations(tmp_path):
    log = tmp_path / "child.log"
    state = tmp_path / "state.json"

    # t=0: only cloning (no markers yet)
    log.write_text("run-bench-cloud (warm run)")
    s0 = startup_state(log, state, now=1000.0)
    assert s0["phase"] == "cloning"
    steps = {x["key"]: x for x in s0["steps"]}
    assert steps["cloning"]["status"] == "active"
    assert steps["provisioning"]["status"] == "pending"

    # t=30: provisioning started 30s after cloning first seen
    log.write_text("▶️  Starting warm machine m1 ...")
    s1 = startup_state(log, state, now=1030.0)
    assert s1["phase"] == "provisioning"
    steps = {x["key"]: x for x in s1["steps"]}
    assert steps["cloning"]["status"] == "done"
    assert steps["cloning"]["elapsed_s"] == 30.0          # 1030 - 1000
    assert steps["provisioning"]["status"] == "active"
    assert steps["provisioning"]["elapsed_s"] == 0.0

    # t=200: still provisioning → active elapsed grows
    s2 = startup_state(log, state, now=1200.0)
    assert s2["steps"][1]["elapsed_s"] == 170.0            # 1200 - 1030
    assert s2["total_elapsed_s"] == 200.0                  # 1200 - 1000
    assert s2["total_expected_s"] == 90 + 180 + 45 + 90


def test_startup_state_reaches_booting(tmp_path):
    log = tmp_path / "child.log"
    state = tmp_path / "state.json"
    log.write_text(
        "▶️  Starting warm machine m1\n"
        "✅ Machine started + ssh-ready (m1)\n"
        "✅ On-box driver launched + confirmed running."
    )
    s = startup_state(log, state, now=5000.0)
    assert s["phase"] == "booting"
    steps = {x["key"]: x for x in s["steps"]}
    assert steps["booting"]["status"] == "active"
    assert steps["provisioning"]["status"] == "done"
    assert steps["staging"]["status"] == "done"
