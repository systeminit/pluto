export interface DeploymentProgress {
  step: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  details?: any;
}

export interface DeploymentResult {
  success: boolean;
  error?: string;
  changeSetId?: string;
  deploymentId?: string;
  progress: DeploymentProgress[];
}

export interface ServiceResult<T = any> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface ChangeSetResult extends ServiceResult {
  changeSetId?: string;
}

export interface ComponentResult extends ServiceResult {
  componentId?: string;
}

export interface ActionResult extends ServiceResult {
  actionResult?: any;
}

export interface CreateComponentOptions {
  attributes?: Record<string, any>;
  viewName?: string;
}