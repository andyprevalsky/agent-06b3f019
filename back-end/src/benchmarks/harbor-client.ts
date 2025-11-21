import { spawn } from 'child_process';
import * as path from 'path';

export interface HarborTask {
  id: string;
  instruction: string;
  success: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface HarborRunOptions {
  dataset?: string;
  version?: string;
  taskPath?: string;  // Use local task path instead of dataset (for patched Terminal-Bench tasks)
  model: string;
  agent: string;
  agentImportPath?: string;  // Custom agent import path (e.g., "path/to/agent.py:ClassName")
  environment: 'daytona' | 'modal' | 'local';
  forceBuild?: boolean;  // Force rebuild Docker image (required for patched tasks)
  nConcurrent?: number;
  tasks?: string[]; // Optional: specific task IDs to run
  outputDir?: string;
}

export interface HarborRunResult {
  success: boolean;
  tasks: HarborTask[];
  totalDurationMs: number;
  errorMessage?: string;
}

/**
 * Harbor Python CLI wrapper for running Terminal-Bench evaluations
 * in containerized cloud environments (Daytona/Modal)
 * 
 * Installation: 
 * 1. Install uv: https://docs.astral.sh/uv/
 * 2. Install harbor: uv tool install harbor
 * 3. Set DAYTONA_API_KEY in .env file
 */
export class HarborClient {
  private harborCommand: string[];

  constructor() {
    // Try 'harbor' command first (uv tool install), fallback to python module
    this.harborCommand = ['harbor'];
  }

  /**
   * Check if Harbor is installed
   */
  async checkInstalled(): Promise<boolean> {
    // Try common installation locations first
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const commonPaths = [
      `${homeDir}/.local/bin/harbor`,
      '/usr/local/bin/harbor',
      'harbor'
    ];

    for (const path of commonPaths) {
      const check = await this.tryCommand([path, '--help']);
      if (check) {
        this.harborCommand = [path];
        console.log(`✓ Found Harbor at: ${path}`);
        return true;
      }
    }

    // Try python module as fallback
    const pythonCheck = await this.tryCommand(['python3', '-m', 'harbor', '--version']);
    if (pythonCheck) {
      this.harborCommand = ['python3', '-m', 'harbor'];
      console.log(`✓ Found Harbor as Python module`);
      return true;
    }

    console.error('✗ Harbor not found in any known location');
    return false;
  }

  private async tryCommand(cmd: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const checkProcess = spawn(cmd[0], cmd.slice(1));

      checkProcess.on('close', (code) => {
        resolve(code === 0);
      });
      
      checkProcess.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * List available datasets
   */
  async listDatasets(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = [...this.harborCommand.slice(1), 'datasets', 'list'];
      const process = spawn(this.harborCommand[0], args);
      let output = '';
      let error = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.stderr.on('data', (data) => {
        error += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          // Parse dataset list from output
          const datasets = output
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .map(line => line.trim());
          resolve(datasets);
        } else {
          reject(new Error(`Failed to list datasets: ${error}`));
        }
      });
    });
  }

  /**
   * Run Harbor evaluation
   */
  async run(options: HarborRunOptions): Promise<HarborRunResult> {
    const startTime = Date.now();
    
    // Build Harbor command args
    const args = [
      ...this.harborCommand.slice(1), // Include any base args (e.g., '-m', 'harbor' for python module)
      'run',
    ];
    
    // Use either local task path or dataset reference
    if (options.taskPath) {
      args.push('--path', options.taskPath);
    } else if (options.dataset && options.version) {
      args.push('-d', `${options.dataset}@${options.version}`);
    } else {
      throw new Error('Either taskPath or (dataset + version) must be provided');
    }
    
    args.push(
      '-m', options.model,
      '--env', options.environment,
    );

    // Add agent - either custom import path OR built-in agent name
    if (options.agentImportPath) {
      // Custom agent via import path (don't use -a flag, it conflicts)
      args.push('--agent-import-path', options.agentImportPath);
    } else {
      // Built-in agent
      args.push('-a', options.agent);
    }

    // Add Rose API credentials as environment kwargs (passed to container)
    if (process.env.ROSE_API_KEY && process.env.SUPABASE_URL) {
      // Strip quotes from SUPABASE_URL if present (dotenv may include them)
      const supabaseUrl = process.env.SUPABASE_URL.replace(/^["']|["']$/g, '');
      const roseApiUrl = `${supabaseUrl}/functions/v1/completions`;
      console.log(`  🔑 Passing Rose credentials to container:`);
      console.log(`     ROSE_API_URL: ${roseApiUrl}`);
      console.log(`     ROSE_API_KEY: ${process.env.ROSE_API_KEY.substring(0, 10)}...`);
      
      args.push('--ek', `ROSE_API_KEY=${process.env.ROSE_API_KEY}`);
      args.push('--ek', `ROSE_API_URL=${roseApiUrl}`);
      args.push('--ek', `SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY}`);
      if (process.env.ROSE_MAX_ITERATIONS) {
        args.push('--ek', `ROSE_MAX_ITERATIONS=${process.env.ROSE_MAX_ITERATIONS}`);
      }
    } else {
      console.warn('⚠️  Missing ROSE_API_KEY or SUPABASE_URL - Rose agent may fail');
    }

    // Add optional parameters
    if (options.forceBuild) {
      args.push('--force-build');
    }
    
    if (options.nConcurrent) {
      args.push('-n', options.nConcurrent.toString());
    }

    if (options.outputDir) {
      args.push('--jobs-dir', options.outputDir);
    }

    // Add task filtering if specific tasks requested
    if (options.tasks && options.tasks.length > 0) {
      options.tasks.forEach(taskName => args.push('--task-name', taskName));
    }

    console.log(`🚢 Running Harbor: ${this.harborCommand[0]} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      // Strip quotes from SUPABASE_URL if present (dotenv may include them)
      const supabaseUrl = process.env.SUPABASE_URL?.replace(/^["']|["']$/g, '') || '';
      
      const harborProcess = spawn(this.harborCommand[0], args, {
        env: {
          ...process.env,
          DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
          MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID,
          MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
          // Rose API credentials for custom agent
          ROSE_API_URL: supabaseUrl ? `${supabaseUrl}/functions/v1/completions` : undefined,
          ROSE_API_KEY: process.env.ROSE_API_KEY,
        }
      });

      let output = '';
      let error = '';

      harborProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        // Stream logs for progress tracking
        console.log('Harbor:', chunk.trim());
      });

      harborProcess.stderr.on('data', (data) => {
        const chunk = data.toString();
        error += chunk;
        console.error('Harbor stderr:', chunk.trim());
      });

      harborProcess.on('close', (code) => {
        const totalDurationMs = Date.now() - startTime;

        if (code === 0) {
          try {
            // Parse Harbor's output
            const result = this.parseHarborOutput(output, options.nConcurrent || 1);
            
            if (result.tasks.length === 0) {
              console.warn('⚠️ Harbor completed but returned no tasks. This may indicate the dataset is empty or tasks were filtered out.');
            }
            
            resolve({
              success: true,
              tasks: result.tasks,
              totalDurationMs,
            });
          } catch (parseError) {
            console.error('Failed to parse Harbor output:', parseError);
            console.error('Raw output:', output.substring(0, 500));
            resolve({
              success: false,
              tasks: [],
              totalDurationMs,
              errorMessage: `Failed to parse output: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
            });
          }
        } else {
          resolve({
            success: false,
            tasks: [],
            totalDurationMs,
            errorMessage: `Harbor exited with code ${code}: ${error}`,
          });
        }
      });

      harborProcess.on('error', (err) => {
        resolve({
          success: false,
          tasks: [],
          totalDurationMs: Date.now() - startTime,
          errorMessage: `Failed to spawn Harbor process: ${err.message}`,
        });
      });
    });
  }

  /**
   * Parse Harbor's output format
   */
  private parseHarborOutput(output: string, expectedTasks: number = 1): { tasks: HarborTask[] } {
    // Harbor outputs JSON results, typically at the end of the output
    // Try to find and parse the JSON structure
    
    // Look for JSON blocks in the output
    const jsonMatch = output.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Convert Harbor's task format to our format
      const tasks: HarborTask[] = (parsed.tasks || []).map((task: any) => ({
        id: task.id || task.task_id || 'unknown',
        instruction: task.instruction || task.task || '',
        success: task.success || task.passed || false,
        output: task.output || task.result || '',
        error: task.error || '',
        durationMs: task.duration_ms || task.duration || 0,
      }));

      return { tasks };
    }

    // Fallback: try to extract task results from logs
    // Harbor typically outputs: "Task X: PASSED" or "Task X: FAILED"
    const taskResults: HarborTask[] = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const passMatch = line.match(/Task\s+(\S+):\s*PASSED/i);
      const failMatch = line.match(/Task\s+(\S+):\s*FAILED/i);
      
      if (passMatch) {
        taskResults.push({
          id: passMatch[1],
          instruction: '',
          success: true,
        });
      } else if (failMatch) {
        taskResults.push({
          id: failMatch[1],
          instruction: '',
          success: false,
        });
      }
    }

    if (taskResults.length > 0) {
      return { tasks: taskResults };
    }

    throw new Error('No valid task results found in Harbor output');
  }
}

/**
 * Default Harbor client instance
 */
export const harborClient = new HarborClient();

