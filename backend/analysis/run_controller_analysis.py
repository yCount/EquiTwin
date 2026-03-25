from __future__ import annotations

import argparse
import json
import os
import sys
import textwrap
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

try:
    from sklearn.exceptions import InconsistentVersionWarning
except Exception:  # pragma: no cover - sklearn may not expose this everywhere
    InconsistentVersionWarning = None


BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BACKEND_DIR / "exports" / "controller_analysis"
CHARTS_DIRNAME = "charts"


def _configure_environment() -> None:
    os.environ.setdefault("ARTIFACTS_ROOT", str(BACKEND_DIR / "artifacts"))
    os.environ.setdefault("LOKY_MAX_CPU_COUNT", str(os.cpu_count() or 1))
    os.environ["WEATHER_LAT"] = ""
    os.environ["WEATHER_LON"] = ""
    os.environ.pop("DATABASE_URL", None)


def _configure_warnings() -> None:
    if InconsistentVersionWarning is not None:
        warnings.filterwarnings("ignore", category=InconsistentVersionWarning)
    warnings.filterwarnings(
        "ignore",
        message="Could not find the number of physical cores",
        category=UserWarning,
    )
    warnings.filterwarnings(
        "ignore",
        message="Values in x were outside bounds during a minimize step, clipping to bounds",
        category=RuntimeWarning,
    )


@dataclass(frozen=True)
class Scenario:
    name: str
    title: str
    description: str
    config: Dict[str, Any]


SCENARIOS: List[Scenario] = [
    Scenario(
        name="morning_cold_start",
        title="Morning Cold Start",
        description="Cold building entering the preheat window before work begins.",
        config={
            "ticks": 32,
            "speed": 0,
            "setpoint": 21.0,
            "nightSetpoint": 15.0,
            "nOccupants": 10,
            "initTemp": 14.0,
            "startHour": 4.0,
            "activeFeatures": ["energy", "temperature", "occupancy"],
        },
    ),
    Scenario(
        name="full_day",
        title="Full Day",
        description="End-to-end day covering night, preheat, work, and post-work drift-down.",
        config={
            "ticks": 96,
            "speed": 0,
            "setpoint": 21.0,
            "nightSetpoint": 15.0,
            "nOccupants": 10,
            "initTemp": 14.0,
            "startHour": 0.0,
            "activeFeatures": ["energy", "temperature", "occupancy"],
        },
    ),
    Scenario(
        name="occupied_midday_disturbance",
        title="Occupied Midday Disturbance",
        description="Occupied work-period recovery from a below-target initial condition.",
        config={
            "ticks": 24,
            "speed": 0,
            "setpoint": 21.0,
            "nightSetpoint": 15.0,
            "nOccupants": 10,
            "initTemp": 18.5,
            "startHour": 9.0,
            "activeFeatures": ["energy", "temperature", "occupancy"],
        },
    ),
]


def _load_backend_app():
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    import app as backend_app  # noqa: WPS433 - runtime import after env setup

    return backend_app


def _run_scenario(client: TestClient, scenario: Scenario) -> Dict[str, Any]:
    ticks: List[Dict[str, Any]] = []
    started: Optional[Dict[str, Any]] = None
    complete: Optional[Dict[str, Any]] = None

    with client.websocket_connect("/simulation/ws") as ws:
        ws.send_json({"type": "start", "config": scenario.config})
        while True:
            msg = ws.receive_json()
            msg_type = msg.get("type")
            if msg_type == "started":
                started = msg
            elif msg_type == "tick":
                ticks.append(msg)
            elif msg_type == "complete":
                complete = msg
                break
            elif msg_type == "error":
                raise RuntimeError(f"{scenario.name}: {msg.get('message', 'unknown error')}")
            elif msg_type == "stopped":
                break

    if started is None or complete is None:
        raise RuntimeError(f"{scenario.name}: simulation did not complete cleanly")

    return {"scenario": scenario, "started": started, "complete": complete, "ticks": ticks}


def _first_occupied_index(ticks: Iterable[Dict[str, Any]]) -> Optional[int]:
    for idx, tick in enumerate(ticks):
        if float(tick.get("n_people") or 0) > 0:
            return idx
    return None


def _reference_temperature(tick: Dict[str, Any]) -> float:
    ref = tick.get("t_star_now")
    if ref is None:
        ref = tick.get("setpoint", 0.0)
    return float(ref)


def _occupied_ticks(ticks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [tick for tick in ticks if float(tick.get("n_people") or 0) > 0]


def _readiness_minutes(ticks: List[Dict[str, Any]], threshold_c: float = 0.5) -> Optional[int]:
    first_occ = _first_occupied_index(ticks)
    if first_occ is None:
        return None

    ref = _reference_temperature(ticks[first_occ])
    for idx in range(first_occ, len(ticks)):
        if abs(float(ticks[idx]["indoor_temp"]) - ref) <= threshold_c:
            return (idx - first_occ) * 15
    return None


def _scenario_summary(result: Dict[str, Any]) -> Dict[str, Any]:
    scenario = result["scenario"]
    ticks = result["ticks"]
    complete = result["complete"]
    started = result["started"]

    qp_ticks = [tick for tick in ticks if tick.get("qp_solver") == "SLSQP"]
    converged = [tick for tick in qp_ticks if tick.get("qp_converged") is True]
    non_converged = [tick for tick in qp_ticks if tick.get("qp_converged") is False]
    fallback_ticks = [
        tick
        for tick in ticks
        if tick.get("qp_solver") == "proportional_fallback" or not tick.get("mpc_active", False)
    ]
    occ_ticks = _occupied_ticks(ticks)

    occupied_errors = [
        abs(float(tick["indoor_temp"]) - _reference_temperature(tick))
        for tick in occ_ticks
    ]
    occupied_within = [
        error for error in occupied_errors if error <= 1.0
    ]
    hvac_series = [float(tick.get("hvac_w") or 0.0) for tick in ticks]
    qp_iters = [int(tick.get("qp_iter") or 0) for tick in qp_ticks]
    energy_forecasts = [
        float(tick["forecast_energy_st1"])
        for tick in ticks
        if tick.get("forecast_energy_st1") is not None
    ]

    summary = {
        "scenario": scenario.name,
        "title": scenario.title,
        "description": scenario.description,
        "has_mpc": bool(started.get("has_mpc")),
        "ticks": len(ticks),
        "mpc_active_ticks": sum(1 for tick in ticks if tick.get("mpc_active")),
        "qp_ticks": len(qp_ticks),
        "qp_converged_ticks": len(converged),
        "qp_nonconverged_ticks": len(non_converged),
        "qp_convergence_rate": round(len(converged) / len(qp_ticks), 3) if qp_ticks else None,
        "fallback_ticks": len(fallback_ticks),
        "max_qp_iter": max(qp_iters, default=0),
        "avg_qp_iter": round(sum(qp_iters) / len(qp_iters), 2) if qp_iters else None,
        "first_occupancy_tick": _first_occupied_index(ticks),
        "readiness_after_first_occupancy_min": _readiness_minutes(ticks),
        "occupied_temp_mae_to_target_c": (
            round(sum(occupied_errors) / len(occupied_errors), 3) if occupied_errors else None
        ),
        "occupied_within_1c_rate": (
            round(len(occupied_within) / len(occupied_errors), 3) if occupied_errors else None
        ),
        "occupied_samples": len(occupied_errors),
        "avg_abs_temp_error_all_ticks_c": round(
            sum(abs(float(tick["indoor_temp"]) - _reference_temperature(tick)) for tick in ticks)
            / max(1, len(ticks)),
            3,
        ),
        "total_kwh": complete.get("total_kwh"),
        "final_temp_c": complete.get("final_temp"),
        "max_hvac_w": round(max(hvac_series), 1) if hvac_series else None,
        "avg_hvac_kw": round(sum(hvac_series) / len(hvac_series) / 1000.0, 3) if hvac_series else None,
        "avg_forecast_energy_st1_w": (
            round(sum(energy_forecasts) / len(energy_forecasts), 1) if energy_forecasts else None
        ),
        "min_forecast_energy_st1_w": min(energy_forecasts) if energy_forecasts else None,
        "negative_forecast_energy_ticks": sum(1 for value in energy_forecasts if value < 0.0),
        "mode_counts": _mode_counts(ticks),
        "config": scenario.config,
    }
    summary["issues"] = _derive_issues(summary)
    return summary


def _mode_counts(ticks: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for tick in ticks:
        mode = str(tick.get("mode", "UNKNOWN"))
        counts[mode] = counts.get(mode, 0) + 1
    return counts


def _derive_issues(summary: Dict[str, Any]) -> List[str]:
    issues: List[str] = []
    convergence = summary.get("qp_convergence_rate")
    if convergence is not None and convergence < 0.7:
        issues.append(
            f"QP convergence is only {convergence:.1%}, with repeated solves hitting the 500-iteration cap."
        )

    occ_mae = summary.get("occupied_temp_mae_to_target_c")
    if occ_mae is not None and occ_mae > 1.0:
        issues.append(
            f"Occupied temperature tracking is weak at {occ_mae:.2f}C MAE to target."
        )

    within_band = summary.get("occupied_within_1c_rate")
    if within_band is not None and within_band < 0.8:
        issues.append(
            f"Only {within_band:.1%} of occupied ticks stay within +/-1C of target."
        )

    readiness = summary.get("readiness_after_first_occupancy_min")
    if readiness is not None and readiness > 15:
        issues.append(
            f"Recovery after first occupancy still takes {readiness} minutes."
        )

    negative_forecasts = summary.get("negative_forecast_energy_ticks")
    if negative_forecasts:
        issues.append(
            f"Short-term energy forecast is negative on {negative_forecasts} ticks, which is physically suspicious."
        )

    if not issues:
        issues.append("No critical runtime issues were observed in this scenario.")
    return issues


def _ticks_frame(results: List[Dict[str, Any]]) -> pd.DataFrame:
    rows: List[Dict[str, Any]] = []
    for result in results:
        scenario = result["scenario"]
        for tick in result["ticks"]:
            sim_time = pd.to_datetime(tick["sim_time"], utc=True, errors="coerce")
            rows.append(
                {
                    "scenario": scenario.name,
                    "title": scenario.title,
                    "tick": int(tick["tick"]),
                    "hours_since_start": int(tick["tick"]) * 0.25,
                    "sim_time": sim_time,
                    "mode": tick.get("mode"),
                    "mpc_active": bool(tick.get("mpc_active", False)),
                    "qp_solver": tick.get("qp_solver"),
                    "qp_converged": tick.get("qp_converged"),
                    "qp_iter": tick.get("qp_iter"),
                    "indoor_temp": tick.get("indoor_temp"),
                    "setpoint": tick.get("setpoint"),
                    "t_star_now": tick.get("t_star_now"),
                    "n_people": tick.get("n_people"),
                    "hvac_w": tick.get("hvac_w"),
                    "outdoor_temp": tick.get("outdoor_temp"),
                    "forecast_energy_st1": tick.get("forecast_energy_st1"),
                    "e_budget_wh": tick.get("e_budget_wh"),
                }
            )
    frame = pd.DataFrame(rows)
    if not frame.empty:
        frame["temp_ref"] = frame["t_star_now"].fillna(frame["setpoint"])
        frame["temp_abs_error"] = (frame["indoor_temp"] - frame["temp_ref"]).abs()
    return frame


def _summary_frame(summaries: List[Dict[str, Any]]) -> pd.DataFrame:
    frame = pd.DataFrame(summaries)
    if not frame.empty:
        frame["qp_convergence_pct"] = frame["qp_convergence_rate"] * 100.0
        frame["occupied_within_1c_pct"] = frame["occupied_within_1c_rate"] * 100.0
    return frame


def _style_axis(ax, title: str, ylabel: str) -> None:
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.grid(axis="y", alpha=0.25)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def _annotate_bars(ax, bars, suffix: str = "") -> None:
    for bar in bars:
        height = bar.get_height()
        ax.text(
            bar.get_x() + bar.get_width() / 2.0,
            height,
            f"{height:.1f}{suffix}",
            ha="center",
            va="bottom",
            fontsize=9,
        )


def _plot_summary_dashboard(summary_df: pd.DataFrame, output_path: Path) -> None:
    labels = summary_df["title"].tolist()
    x = np.arange(len(labels))

    fig, axes = plt.subplots(2, 2, figsize=(14, 10), constrained_layout=True)

    bars = axes[0, 0].bar(x, summary_df["qp_convergence_pct"], color="#2563eb")
    axes[0, 0].set_xticks(x, labels, rotation=15, ha="right")
    axes[0, 0].set_ylim(0, 100)
    _style_axis(axes[0, 0], "QP Convergence Rate", "Percent")
    _annotate_bars(axes[0, 0], bars, "%")

    bars = axes[0, 1].bar(x, summary_df["occupied_temp_mae_to_target_c"], color="#dc2626")
    axes[0, 1].set_xticks(x, labels, rotation=15, ha="right")
    _style_axis(axes[0, 1], "Occupied Temperature MAE", "C")
    _annotate_bars(axes[0, 1], bars, "C")

    bars = axes[1, 0].bar(x, summary_df["occupied_within_1c_pct"], color="#16a34a")
    axes[1, 0].set_xticks(x, labels, rotation=15, ha="right")
    axes[1, 0].set_ylim(0, 100)
    _style_axis(axes[1, 0], "Occupied Ticks Within +/-1C", "Percent")
    _annotate_bars(axes[1, 0], bars, "%")

    bars = axes[1, 1].bar(x, summary_df["total_kwh"], color="#f59e0b")
    axes[1, 1].set_xticks(x, labels, rotation=15, ha="right")
    _style_axis(axes[1, 1], "Total HVAC Energy", "kWh")
    _annotate_bars(axes[1, 1], bars, " kWh")

    fig.suptitle("Controller Analysis Summary", fontsize=16)
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def _plot_timeseries(frame: pd.DataFrame, scenario: Scenario, output_path: Path) -> None:
    if frame.empty:
        return

    fig, axes = plt.subplots(
        2,
        1,
        figsize=(14, 8),
        sharex=True,
        constrained_layout=True,
        gridspec_kw={"height_ratios": [2.0, 1.2]},
    )

    x = frame["hours_since_start"]
    axes[0].plot(x, frame["indoor_temp"], label="Indoor Temp", color="#1d4ed8", linewidth=2.2)
    axes[0].plot(x, frame["temp_ref"], label="Target / T*", color="#dc2626", linewidth=2.0)
    axes[0].plot(
        x,
        frame["setpoint"],
        label="Mode Setpoint",
        color="#f59e0b",
        linewidth=1.5,
        linestyle="--",
    )

    occupied = frame["n_people"].fillna(0) > 0
    if occupied.any():
        axes[0].fill_between(
            x,
            frame["indoor_temp"].min() - 0.5,
            frame["indoor_temp"].max() + 0.5,
            where=occupied,
            alpha=0.08,
            color="#16a34a",
            label="Occupied Period",
        )

    bad = frame["qp_converged"] == False  # noqa: E712 - explicit False comparison
    if bad.any():
        axes[0].scatter(
            frame.loc[bad, "hours_since_start"],
            frame.loc[bad, "indoor_temp"],
            color="#7f1d1d",
            s=36,
            label="Non-converged Tick",
            zorder=5,
        )

    axes[0].set_ylabel("Temperature (C)")
    axes[0].set_title(f"{scenario.title}: Temperature Tracking")
    axes[0].grid(alpha=0.25)
    axes[0].legend(loc="upper right", ncol=2)
    axes[0].spines["top"].set_visible(False)
    axes[0].spines["right"].set_visible(False)

    axes[1].plot(x, frame["hvac_w"], color="#7c3aed", linewidth=2.0, label="HVAC Power")
    axes[1].set_ylabel("HVAC Power (W)")
    axes[1].set_xlabel("Hours Since Scenario Start")
    axes[1].grid(alpha=0.25)
    axes[1].spines["top"].set_visible(False)
    axes[1].spines["right"].set_visible(False)

    occ_ax = axes[1].twinx()
    occ_ax.step(x, frame["n_people"], where="mid", color="#059669", linewidth=1.8, label="Occupancy")
    occ_ax.set_ylabel("People")
    occ_ax.spines["top"].set_visible(False)

    lines_a, labels_a = axes[1].get_legend_handles_labels()
    lines_b, labels_b = occ_ax.get_legend_handles_labels()
    axes[1].legend(lines_a + lines_b, labels_a + labels_b, loc="upper right")

    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def _write_findings_report(
    output_path: Path,
    summaries: List[Dict[str, Any]],
    summary_df: pd.DataFrame,
) -> None:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    best_comfort = summary_df.sort_values("occupied_temp_mae_to_target_c").iloc[0]
    worst_convergence = summary_df.sort_values("qp_convergence_rate").iloc[0]
    slowest_recovery = summary_df.sort_values(
        "readiness_after_first_occupancy_min",
        ascending=False,
        na_position="last",
    ).iloc[0]

    lines: List[str] = [
        "Controller Analysis Findings",
        "=" * 29,
        "",
        f"Generated: {generated_at}",
        f"Artifacts root: {os.environ.get('ARTIFACTS_ROOT')}",
        "Weather: disabled for deterministic local analysis",
        "",
        "Headline Findings",
        "-----------------",
        (
            f"1. Best steady occupied performance came from '{best_comfort['title']}', "
            f"with occupied MAE {best_comfort['occupied_temp_mae_to_target_c']:.3f}C "
            f"and {best_comfort['occupied_within_1c_pct']:.1f}% of occupied ticks within +/-1C."
        ),
        (
            f"2. Worst solver performance came from '{worst_convergence['title']}', "
            f"with convergence rate {worst_convergence['qp_convergence_pct']:.1f}% "
            f"and max iteration count {int(worst_convergence['max_qp_iter'])}."
        ),
        (
            f"3. Slowest occupied recovery came from '{slowest_recovery['title']}', "
            f"requiring {slowest_recovery['readiness_after_first_occupancy_min']} minutes "
            "to reach within 0.5C of target after occupancy started."
        ),
        "",
        "Cross-Scenario Interpretation",
        "-----------------------------",
        (
            "The controller performs well once the building is already near target. "
            "The weak region is transient recovery, especially cold-start preheat and "
            "occupied recovery from below-target conditions."
        ),
        (
            "Non-convergence is not causing total control failure in these scenarios, "
            "but repeated 500-iteration solves indicate that the optimization is regularly "
            "running into a hard numerical limit instead of cleanly settling."
        ),
        (
            "The morning cold-start scenario also produced negative short-term energy forecasts, "
            "which suggests the energy forecast output should be sanity-checked before using it "
            "as a planning signal."
        ),
        "",
        "Scenario Details",
        "----------------",
    ]

    for summary in summaries:
        lines.extend(
            [
                f"{summary['title']} ({summary['scenario']})",
                f"  Description: {summary['description']}",
                f"  Convergence: {summary['qp_convergence_rate']:.1%} "
                f"({summary['qp_converged_ticks']}/{summary['qp_ticks']} QP ticks)",
                f"  Occupied MAE: {summary['occupied_temp_mae_to_target_c']:.3f}C",
                f"  Within +/-1C: {summary['occupied_within_1c_rate']:.1%}",
                f"  Recovery after first occupancy: {summary['readiness_after_first_occupancy_min']} min",
                f"  Total energy: {summary['total_kwh']} kWh",
                f"  Avg HVAC power: {summary['avg_hvac_kw']} kW",
                f"  Negative forecast-energy ticks: {summary['negative_forecast_energy_ticks']}",
                "  Issues:",
            ]
        )
        lines.extend(f"    - {issue}" for issue in summary["issues"])
        lines.append("")

    lines.extend(
        [
            "Recommended Next Actions",
            "------------------------",
            (
                "1. Move preheat earlier and raise the night HVAC ceiling in "
                "backend/simulate_house.py to reduce the cold-start deficit before occupancy."
            ),
            (
                "2. Extend the MPC preheat window and strengthen empty-building comfort weighting "
                "in backend/equitwin_mpc/hierarchical.py."
            ),
            (
                "3. Improve solver robustness before extending horizon length, because the current "
                "bottleneck is repeated iteration-cap hits rather than a lack of look-ahead."
            ),
            (
                "4. Align the local scikit-learn runtime with the version used to create the "
                "saved model artifacts before trusting detailed forecast-quality comparisons."
            ),
            "",
            "Generated Files",
            "---------------",
            "summary.json            scenario-level metrics and configuration",
            "ticks.csv               combined per-tick trace data",
            "charts/summary.png      cross-scenario dashboard",
            "charts/<scenario>.png   per-scenario trace charts",
        ]
    )

    output_path.write_text("\n".join(lines), encoding="utf-8")


def _write_outputs(
    output_dir: Path,
    summaries: List[Dict[str, Any]],
    ticks_df: pd.DataFrame,
    summary_df: pd.DataFrame,
) -> None:
    charts_dir = output_dir / CHARTS_DIRNAME
    charts_dir.mkdir(parents=True, exist_ok=True)

    (output_dir / "summary.json").write_text(
        json.dumps(summaries, indent=2),
        encoding="utf-8",
    )
    ticks_df.to_csv(output_dir / "ticks.csv", index=False)

    _plot_summary_dashboard(summary_df, charts_dir / "summary.png")

    for scenario in SCENARIOS:
        scenario_frame = ticks_df[ticks_df["scenario"] == scenario.name].copy()
        _plot_timeseries(scenario_frame, scenario, charts_dir / f"{scenario.name}.png")

    _write_findings_report(output_dir / "findings.txt", summaries, summary_df)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run controller simulation scenarios and generate findings artifacts."
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Directory where findings, raw data, and charts will be written.",
    )
    args = parser.parse_args()

    _configure_environment()
    _configure_warnings()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    backend_app = _load_backend_app()

    results: List[Dict[str, Any]] = []
    with TestClient(backend_app.app) as client:
        for scenario in SCENARIOS:
            results.append(_run_scenario(client, scenario))

    summaries = [_scenario_summary(result) for result in results]
    ticks_df = _ticks_frame(results)
    summary_df = _summary_frame(summaries)

    _write_outputs(output_dir, summaries, ticks_df, summary_df)

    message = textwrap.dedent(
        f"""
        Controller analysis complete.
        Findings: {output_dir / 'findings.txt'}
        Summary:  {output_dir / 'summary.json'}
        Ticks:    {output_dir / 'ticks.csv'}
        Charts:   {output_dir / CHARTS_DIRNAME}
        """
    ).strip()
    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
