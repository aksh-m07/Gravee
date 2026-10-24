export type FaultType = "none" | "stuck" | "loop" | "blocked" | "offtask" | "drift";

export interface ProposedAction {
  kind: "click" | "type" | "wait" | "scroll" | "finish";
  label: string; // visible text of the element the agent is about to act on
}

export interface EpisodeStep {
  t: number;
  obs: string; // screenshot file, relative to the episode directory
  action: ProposedAction;
  note: string; // the agent's stated reason for the action
}

export interface Episode {
  id: string;
  split: "train" | "val" | "eval";
  scenario: string;
  task: string;
  fault: FaultType;
  /** First step at which intervening is justified. null for fault-free episodes. */
  onset: number | null;
  steps: EpisodeStep[];
  seeded: true; // every episode is scripted in the sandbox world; never presented as production data
}

export type Decision = "allow" | "hold" | "halt";

export type Signal = "visual_anomaly" | "stuck" | "loop" | "risky_action";
