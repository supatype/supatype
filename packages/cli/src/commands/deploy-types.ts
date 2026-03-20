/**
 * Deployment tier limits for static site hosting.
 */

export type Tier = "free" | "pro" | "team" | "enterprise"

export interface DeploymentLimits {
  maxBuildOutputMb: number
  buildMinutesPerMonth: number
  maxPreviewDeployments: number
  deploymentRetention: number
  cdnEnabled: boolean
  buildMinuteOverageRate: number // £ per minute, 0 = no overage allowed
}

export const TIER_LIMITS: Record<Tier, DeploymentLimits> = {
  free: {
    maxBuildOutputMb: 50,
    buildMinutesPerMonth: 100,
    maxPreviewDeployments: 1,
    deploymentRetention: 3,
    cdnEnabled: false,
    buildMinuteOverageRate: 0,
  },
  pro: {
    maxBuildOutputMb: 500,
    buildMinutesPerMonth: 1000,
    maxPreviewDeployments: 5,
    deploymentRetention: 10,
    cdnEnabled: true,
    buildMinuteOverageRate: 0.01,
  },
  team: {
    maxBuildOutputMb: 2048,
    buildMinutesPerMonth: 5000,
    maxPreviewDeployments: 20,
    deploymentRetention: 25,
    cdnEnabled: true,
    buildMinuteOverageRate: 0.01,
  },
  enterprise: {
    maxBuildOutputMb: -1,
    buildMinutesPerMonth: -1,
    maxPreviewDeployments: -1,
    deploymentRetention: -1,
    cdnEnabled: true,
    buildMinuteOverageRate: 0,
  },
}
