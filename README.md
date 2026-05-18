# EquiTwin

**An AI-Driven Digital Twin for Predictive Energy Monitoring and Hierarchical Model Predictive Control of Smart Buildings**

*Honours Individual Project - Yiğit Sayar · University of Glasgow, School of Computing Science · March 2026*

*Supervised by Dr. Awais Shah and Harsh Vivek Shah*

![EquiTwin Home](home_page.png)

## Overview

EquiTwin is a digital twin for smart buildings that monitors energy use, forecasts future building conditions, and controls heating and ventilation in a simulated environment. It was built and built for deployment at the Sir Alwyn Williams Building (SAWB), University of Glasgow.


Special thanks for my supervisors.

## System Layers

| Layer | Description |
|-------|-------------|
| **Home** | Interactive BIM viewer with live sensor overlays and telemetry status cards |
| **Dashboard** | Historical time-series monitoring, anomaly review, and database inspection |
| **Forecast** | Model training, per-horizon accuracy rankings, and artefact inspection |
| **Controller** | Closed-loop MPC thermal model simulation with solver diagnostics and HVAC output |

## Operational Robustness

Repeated sensor disruptions at SAWB (LoRaWAN timeouts, firmware issues) motivated three design responses: **synthetic data generation** preserving cross-variable physical structure; **PSI drift detection** flagging distribution shift before each training session; and **graceful degradation** ensuring monitoring remains operational under missing artefacts, solver failure, or sensor outage.

*For setup instructions, see [setup.md](setup.md)*
