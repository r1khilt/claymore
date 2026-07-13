# Claymore

> **The autonomous intelligence layer for scientific research.**

Claymore is an autonomous experimentation platform that enables scientific laboratories to continuously conduct research in both computational environments and the physical world. Rather than acting as another chat interface or analysis tool, Claymore understands a lab's collective knowledge, decides what investigations should be performed, executes computational analyses, controls laboratory robots, and continuously learns from the results.

## The Problem

Scientific progress is often limited not by a lack of ideas, but by a lack of time.

Every day, researchers propose promising hypotheses in Slack threads, meetings, notebooks, GitHub issues, and emails. Most are never explored—not because they lack merit, but because experiments are expensive, researchers are busy, and priorities constantly shift.

Claymore ensures those ideas don't stay forgotten.

## What Claymore Does

Claymore acts as a persistent intelligence layer for an entire laboratory.

It continuously ingests scientific context from collaboration tools, codebases, protocols, datasets, and experiment records, building a unified understanding of everything a lab has discussed, tested, and learned.

From there, it can:

* Discover promising hypotheses that were proposed but never investigated.
* Plan the most informative next experiment.
* Perform computational research through Claude Science, including data analysis, machine learning, statistical modeling, literature synthesis, and scientific computing.
* Design, validate, and execute robotic laboratory workflows through Opentrons and PyLabRobot.
* Interpret experimental results and feed them back into scientific memory.
* Continue iterating toward an answer by autonomously selecting the next experiment.

The result is a continuous closed-loop experimentation cycle.

```
Scientific Memory
        │
        ▼
 Discover Hypothesis
        │
        ▼
 Computational Research
 (Claude Science)
        │
        ▼
 Physical Experiment
(Opentrons / PyLabRobot)
        │
        ▼
 Experimental Results
        │
        ▼
 Updated Scientific Memory
        │
        └───────────────► Repeat
```

## Example Workflow

A researcher casually mentions in Slack:

> "The low-magnesium wells looked brighter yesterday. Could magnesium and DNA concentration be interacting?"

The team agrees it is interesting.

Nobody has time to investigate.

Claymore:

* identifies the abandoned hypothesis,
* gathers the previous experiments,
* analyzes historical data,
* trains predictive models,
* determines the most informative experiment,
* generates a robotic workflow,
* executes the computational and physical investigation,
* interprets the results,
* and immediately begins planning the next experiment.

## Key Capabilities

### Persistent Scientific Memory

Claymore connects to a laboratory's digital footprint, including:

* Slack
* GitHub
* Gmail
* Notion
* Experimental protocols
* Meeting transcripts
* Scientific datasets
* Prior experiments

Every finding is grounded in attributed scientific memory.

### Autonomous Computational Research

Claymore can invoke Claude Science whenever deeper computational investigation is required.

Examples include:

* Machine learning
* Statistical analysis
* Bioinformatics
* Data visualization
* Literature review
* Scientific computing

### Autonomous Physical Experimentation

Claymore controls laboratory robotics through Opentrons and PyLabRobot.

It can:

* Generate robotic protocols
* Validate experiments before execution
* Coordinate multiple laboratory instruments
* Execute physical workflows on connected hardware
* Learn from the resulting measurements

## Technology

### AI

* Claude API
* Claude Agent SDK
* Claude Science

### Memory

* Graphiti
* FalkorDB

### Robotics

* Opentrons
* PyLabRobot

### Integrations

* Composio
* Slack
* GitHub
* Gmail
* Notion

### Frontend

* React
* TypeScript
* Three.js

### Backend

* Python
* FastAPI

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
