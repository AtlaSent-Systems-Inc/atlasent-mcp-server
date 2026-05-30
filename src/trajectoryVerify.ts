/**
 * trajectoryVerify — checks whether an agent's current execution step is on
 * an authorized trajectory.
 *
 * POST /v1/trajectory-verify with Bearer auth and a 10-second timeout.
 *
 * Fail-closed: any network or parse error returns
 *   { on_trajectory: false, trajectory_complete: false, verified_at: <now>,
 *     deviation: { reason: <error message> } }
 * so callers can gate unconditionally on on_trajectory.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export interface TrajectoryVerifyResult {
  on_trajectory: boolean;
  trajectory_position?: number;
  trajectory_complete: boolean;
  deviation?: { reason: string; trajectory_id?: string };
  verified_at: string;
}

export interface TrajectoryVerifyOpts {
  apiKey: string;
  baseUrl: string;
  permitToken: string;
  currentStep: string;
  completedSteps?: string[];
  executionContext?: Record<string, unknown>;
}

export async function trajectoryVerify(
  opts: TrajectoryVerifyOpts,
): Promise<TrajectoryVerifyResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/trajectory-verify`;

  const body: Record<string, unknown> = {
    permit_token: opts.permitToken,
    current_step: opts.currentStep,
  };
  if (opts.completedSteps !== undefined) body.completed_steps = opts.completedSteps;
  if (opts.executionContext !== undefined) body.execution_context = opts.executionContext;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      on_trajectory: false,
      trajectory_complete: false,
      verified_at: new Date().toISOString(),
      deviation: { reason: err instanceof Error ? err.message : String(err) },
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return {
      on_trajectory: false,
      trajectory_complete: false,
      verified_at: new Date().toISOString(),
      deviation: { reason: err instanceof Error ? err.message : String(err) },
    };
  }

  // Surface any non-2xx as a deviation so callers stay fail-closed.
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "message" in (data as object)
        ? String((data as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    return {
      on_trajectory: false,
      trajectory_complete: false,
      verified_at: new Date().toISOString(),
      deviation: { reason: msg },
    };
  }

  return data as TrajectoryVerifyResult;
}
