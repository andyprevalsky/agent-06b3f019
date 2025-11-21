import { BaseBenchmarkHarness, BenchmarkQuestion } from './base';
import { harborClient, HarborTask } from '../harbor-client';
import * as fs from 'fs/promises';
import * as path from 'path';

// Note: Using Terminal-Bench 2.0 directly from Harbor's dataset registry
// Harbor will download and cache tasks automatically on first run

export interface TerminalBenchTask extends BenchmarkQuestion {
  harborTaskId?: string;  // Directory ID (e.g., "LEz4caXvpzU9rMBzsJnZA6")
  harborTaskName?: string; // Actual task name Harbor uses (e.g., "pypi-server")
}

// Mapping from Harbor task directory IDs to actual task names  
// Generated from: harbor datasets download terminal-bench@2.0
const TASK_ID_TO_NAME: Record<string, string> = {
  '2Fx6Ues7VLnYo5TdH9smXE': 'llm-inference-batching-scheduler',
  '2gm9aAxh3ufEHTNAcZ8qB3': 'make-doom-for-mips',
  '2hEZAwigfHAA5cnDNAJvfT': 'sqlite-db-truncate',
  '2XNt9VEmH8r9FJdPeH9UxU': 'fix-code-vulnerability',
  '3aN2GgseP4MfXC7ixV7cXB': 'mteb-leaderboard',
  '3HV9wmSrWRW9TuYurepoFx': 'extract-elf',
  '55spjFHXbhXqhkHUB3xfBL': 'query-optimize',
  '5CV2XfZKatcdbEk2ctQQAF': 'path-tracing-reverse',
  '5pwPaf92MGZBJjvqnuBn9d': 'cancel-async-tasks',
  '79ekQLXanbbMZMfTk3qzaF': 'portfolio-optimization',
  '7bFmFkDrFkAzWEnmNWFgw9': 'chess-best-move',
  '7C9njxdDNTb4APfNTmNsi5': 'custom-memory-heap-crash',
  '7s8y623XYuDhmBG6ERABwC': 'install-windows-3.11',
  '7w8vEz8xG5Rmh59QkrpMp2': 'password-recovery',
  '869oU8dUyJHL4uUFPzhKJM': 'rstan-to-pystan',
  '8njYn5Af8tPLKjM5cFeNvR': 'torch-tensor-parallelism',
  '8WGyid6WdyvC3RsCcr7kLU': 'model-extraction-relu-logits',
  '9BGkwkiZs6r3NTmoLCLzr9': 'path-tracing',
  'ArEmuSGC435pAkSA7cv8qw': 'dna-assembly',
  'axUgVSxE9sjGUEHETA9Ddx': 'pytorch-model-recovery',
  'bDZ3NNHZSFq2MH6CzCTykb': 'extract-moves-from-video',
  'ByGtvRdgQehLA6H7TL8cfS': 'regex-log',
  'c3FnWBpp4RmfpMvyGn8Wpv': 'configure-git-webserver',
  'ca36CXF7yAdWnRdpyfoihT': 'overfull-hbox',
  'cEZY7Ut37eqdNnYKPebgYq': 'pytorch-model-cli',
  'CGqXnFmcaVcQCTbCZMpg2T': 'gpt2-codegolf',
  'cMPqfgxjNH2qnnDVdWSFb8': 'multi-source-data-merger',
  'CrxDfvhBFmo3ahvG2RfDM3': 'constraints-scheduling',
  'DcF3L5bfEpwdBkhfr3hgHe': 'hf-model-inference',
  'djEEswskd9fpNSUidkwrfM': 'prove-plus-comm',
  'dqWUpJXGGPsFGfnuwx6Car': 'circuit-fibsqrt',
  'dWGsQxJELwQFMvHVDc5zuS': 'winning-avg-corewars',
  'dXxv47w6VWWtstSMMiefPe': 'fix-ocaml-gc',
  'eUViXxKXCzTue7ywZW59ct': 'nginx-request-logging',
  'fDMeF8ncVH8hFRrdHUkDzM': 'reshard-c4-data',
  'fqGNZJec57abmbsxYbQAz5': 'log-summary-date-ranges',
  'gaFWu2WFUf2THiMG8Ezdxo': 'adaptive-rejection-sampler',
  'GCqHhNMgC2jpcy3h8te5A7': 'build-cython-ext',
  'gHS2mTGhPaYTuJWpCkw4J9': 'qemu-startup',
  'GZXTJdXif2uoqEMrNXfNyB': 'largest-eigenval',
  'H9EGgCK3p6caXKKnhsqu6a': 'build-pov-ray',
  'hf6AShq4ZZHdwGTt8JGpEG': 'polyglot-rust-c',
  'J63TLMqMZcCeiRe8KAiy5T': 'mteb-retrieve',
  'jAoUooKp48ZpCL53Ra9yUk': 'mcmc-sampling-stan',
  'JGX6wXigbfSgX6m298mcKW': 'kv-store-grpc',
  'JK5CeLoen6gxrbEkrjQ94D': 'gcode-to-text',
  'JQfDtvG4qqL3QfwErWynWU': 'break-filter-js-from-html',
  'jWu5FXBKfqdBD9LqMa9a2N': 'tune-mjcf',
  'K56RXLv9fW76nGzkYythKB': 'torch-pipeline-parallelism',
  'Kk55pgeAWyodY7sZSnMpXw': 'dna-insert',
  'kLfrAkLDVW7LCezLUHt4oB': 'git-multibranch',
  'KRPXswDf2LBuozQgKhCqnG': 'code-from-image',
  'KSwQXLapvDLmcHTvZcJVQG': 'headless-terminal',
  'kWbDWup9MzjJLPn6gz9P6H': 'raman-fitting',
  'kzqjKVWxvHZxV5xyLNLqJi': 'fix-git',
  'LeNjAXy6fbV5X852Td8iV9': 'make-mips-interpreter',
  'LEz4caXvpzU9rMBzsJnZA6': 'pypi-server',
  'LVyG59RRyF7y2PiCy5VT3B': 'feal-linear-cryptanalysis',
  'MAyhSNHCZegJvZuPyTitjJ': 'crack-7z-hash',
  'mig33pqGgsU4uNZ5dgPebg': 'git-leak-recovery',
  'mJUNThPAPTj7sAa9DCoPrh': 'protein-assembly',
  'mQoDwFSymGYHYWpETANa3y': 'polyglot-c-py',
  'MWrHdxDHM3npYpRiLMz3iZ': 'write-compressor',
  'n9EXHRQn8C4KGZQgXQEvZU': 'sam-cell-seg',
  'n9YQuCoRJFAyCD3Zs6amRV': 'modernize-scientific-stack',
  'oJLBu7weukw33iq9PEf26P': 'mailman',
  'PBqbNgPwKfCmnNMFQbSbAJ': 'distribution-search',
  'Q3LDEno2RovPVJEJXuoivq': 'merge-diff-arc-agi-task',
  'QDMuuRtnbx7cWNzKkXsGhM': 'compile-compcert',
  'QU8iD2bMsFXumTCQhnBiGz': 'video-processing',
  'QUdXqzZFwRrgRZ7SPHyxto': 'train-fasttext',
  'RkUWMSfgcaHLyc3cnCt62s': 'vulnerable-secret',
  'RNEJHNxbtKQgmztc6q4aKb': 'sparql-university',
  'RyWCxfjAf9RhapMxS2dMks': 'feal-differential-cryptanalysis',
  'S2VRUfRKCUQ2hWH9KJzsbK': 'large-scale-text-editing',
  'SeKnWxFXAqYwFdRQvLn2Wk': 'filter-js-from-html',
  'Skg3RaRNtgRKSRBoJaSgjx': 'openssl-selfsigned-cert',
  'SmKKTsxNnHaHqhzng8SrD2': 'cobol-modernization',
  'T9eC49XFCYopUM2bDKgar3': 'financial-document-processor',
  'TXGXVihdFyGLhhWJdjKoXE': 'build-pmars',
  'V8M9GUmT67TmSKo9FQTdoC': 'count-dataset-tokens',
  'WNjEws4zKtRNWJABpoU892': 'sanitize-git-repo',
  'X4QTPPGhjzjJSVbTTETRUK': 'db-wal-recovery',
  'XUcCMQRrLoqxtCV4Hc9F2a': 'caffe-cifar-10',
  'XX65orYkXVMqTQu7C3JUZY': 'bn-fit-modify',
  'XyJK3D4eSbPWgNt9Bw4RyU': 'regex-chess',
  'YiQMoSRPZzKeHRDhZkwmyd': 'qemu-alpine-ssh',
  'YkDjArg6hKdFYEmdiPrztY': 'schemelike-metacircular-eval',
  'ZDKh9BtehT8SorZTrWLJsn': 'sqlite-with-gcov',
};

/**
 * Terminal-Bench harness using Harbor Framework for containerized execution
 * 
 * Unlike MMLU-Pro (text-based LLM evaluation), Terminal-Bench requires:
 * - Real command execution in sandboxed containers
 * - Automated test scripts for verification
 * - Harbor Framework for orchestration
 */
export class TerminalBenchHarness extends BaseBenchmarkHarness {
  readonly name = "Terminal-Bench 2.0";
  readonly description = "Real-world terminal task completion with containerized execution (89 tasks)";
  readonly questionCount = 89;
  
  /**
   * Load Terminal-Bench dataset
   * Returns Harbor task metadata in BenchmarkQuestion format
   */
  async loadDataset(): Promise<TerminalBenchTask[]> {
    const cacheFile = path.join(__dirname, '../datasets/terminal-bench-cache.json');
    
    // Try cache first
    try {
      const cached = await fs.readFile(cacheFile, 'utf-8');
      console.log('✓ Loaded Terminal-Bench from cache');
      return JSON.parse(cached);
    } catch {
      console.log('Fetching Terminal-Bench 2.0 dataset...');
    }
    
    // Check if Harbor is installed
    const isInstalled = await harborClient.checkInstalled();
    if (!isInstalled) {
      console.warn('⚠️  Harbor not installed. Using sample tasks.');
      console.warn('   Install Harbor: npm run harbor:install');
      const sampleTasks = this.getSampleTasks();
      await this.cacheDataset(cacheFile, sampleTasks);
      return sampleTasks;
    }
    
    // Try to list Harbor datasets
    try {
      const datasets = await harborClient.listDatasets();
      console.log('Available Harbor datasets:', datasets);
      
      // For now, return sample tasks with Harbor task IDs
      // In production, we would parse the actual Harbor dataset structure
      const tasks = this.getHarborTasks();
      await this.cacheDataset(cacheFile, tasks);
      
      console.log(`✓ Loaded ${tasks.length} Terminal-Bench tasks`);
      return tasks;
    } catch (error) {
      console.warn('Could not list Harbor datasets:', error);
      const sampleTasks = this.getSampleTasks();
      await this.cacheDataset(cacheFile, sampleTasks);
      return sampleTasks;
    }
  }
  
  private async cacheDataset(cacheFile: string, tasks: TerminalBenchTask[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(tasks, null, 2));
    } catch (error) {
      console.warn('Failed to cache dataset:', error);
    }
  }
  
  /**
   * Get Harbor-compatible task list
   * These are the ACTUAL task IDs from Terminal-Bench 2.0 dataset
   */
  private getHarborTasks(): TerminalBenchTask[] {
    // ALL 89 real task IDs from Terminal-Bench 2.0
    // Downloaded via: harbor datasets download terminal-bench@2.0
    // WARNING: Each task costs ~$1-2 to run! Use small samples parameter to limit cost.
    const taskIds = [
      "2Fx6Ues7VLnYo5TdH9smXE", "2gm9aAxh3ufEHTNAcZ8qB3", "2hEZAwigfHAA5cnDNAJvfT",
      "2XNt9VEmH8r9FJdPeH9UxU", "3aN2GgseP4MfXC7ixV7cXB", "3HV9wmSrWRW9TuYurepoFx",
      "55spjFHXbhXqhkHUB3xfBL", "5CV2XfZKatcdbEk2ctQQAF", "5pwPaf92MGZBJjvqnuBn9d",
      "79ekQLXanbbMZMfTk3qzaF", "7bFmFkDrFkAzWEnmNWFgw9", "7C9njxdDNTb4APfNTmNsi5",
      "7s8y623XYuDhmBG6ERABwC", "7w8vEz8xG5Rmh59QkrpMp2", "869oU8dUyJHL4uUFPzhKJM",
      "8njYn5Af8tPLKjM5cFeNvR", "8WGyid6WdyvC3RsCcr7kLU", "9BGkwkiZs6r3NTmoLCLzr9",
      "ArEmuSGC435pAkSA7cv8qw", "axUgVSxE9sjGUEHETA9Ddx", "bDZ3NNHZSFq2MH6CzCTykb",
      "ByGtvRdgQehLA6H7TL8cfS", "c3FnWBpp4RmfpMvyGn8Wpv", "ca36CXF7yAdWnRdpyfoihT",
      "cEZY7Ut37eqdNnYKPebgYq", "CGqXnFmcaVcQCTbCZMpg2T", "cMPqfgxjNH2qnnDVdWSFb8",
      "CrxDfvhBFmo3ahvG2RfDM3", "DcF3L5bfEpwdBkhfr3hgHe", "djEEswskd9fpNSUidkwrfM",
      "dqWUpJXGGPsFGfnuwx6Car", "dWGsQxJELwQFMvHVDc5zuS", "dXxv47w6VWWtstSMMiefPe",
      "eUViXxKXCzTue7ywZW59ct", "fDMeF8ncVH8hFRrdHUkDzM", "fqGNZJec57abmbsxYbQAz5",
      "gaFWu2WFUf2THiMG8Ezdxo", "GCqHhNMgC2jpcy3h8te5A7", "gHS2mTGhPaYTuJWpCkw4J9",
      "GZXTJdXif2uoqEMrNXfNyB", "H9EGgCK3p6caXKKnhsqu6a", "hf6AShq4ZZHdwGTt8JGpEG",
      "J63TLMqMZcCeiRe8KAiy5T", "jAoUooKp48ZpCL53Ra9yUk", "JGX6wXigbfSgX6m298mcKW",
      "JK5CeLoen6gxrbEkrjQ94D", "JQfDtvG4qqL3QfwErWynWU", "jWu5FXBKfqdBD9LqMa9a2N",
      "K56RXLv9fW76nGzkYythKB", "Kk55pgeAWyodY7sZSnMpXw", "kLfrAkLDVW7LCezLUHt4oB",
      "KRPXswDf2LBuozQgKhCqnG", "KSwQXLapvDLmcHTvZcJVQG", "kWbDWup9MzjJLPn6gz9P6H",
      "kzqjKVWxvHZxV5xyLNLqJi", "LeNjAXy6fbV5X852Td8iV9", "LEz4caXvpzU9rMBzsJnZA6",
      "LVyG59RRyF7y2PiCy5VT3B", "MAyhSNHCZegJvZuPyTitjJ", "mig33pqGgsU4uNZ5dgPebg",
      "mJUNThPAPTj7sAa9DCoPrh", "mQoDwFSymGYHYWpETANa3y", "MWrHdxDHM3npYpRiLMz3iZ",
      "n9EXHRQn8C4KGZQgXQEvZU", "n9YQuCoRJFAyCD3Zs6amRV", "oJLBu7weukw33iq9PEf26P",
      "PBqbNgPwKfCmnNMFQbSbAJ", "Q3LDEno2RovPVJEJXuoivq", "QDMuuRtnbx7cWNzKkXsGhM",
      "QU8iD2bMsFXumTCQhnBiGz", "QUdXqzZFwRrgRZ7SPHyxto", "RkUWMSfgcaHLyc3cnCt62s",
      "RNEJHNxbtKQgmztc6q4aKb", "RyWCxfjAf9RhapMxS2dMks", "S2VRUfRKCUQ2hWH9KJzsbK",
      "SeKnWxFXAqYwFdRQvLn2Wk", "Skg3RaRNtgRKSRBoJaSgjx", "SmKKTsxNnHaHqhzng8SrD2",
      "T9eC49XFCYopUM2bDKgar3", "TXGXVihdFyGLhhWJdjKoXE", "V8M9GUmT67TmSKo9FQTdoC",
      "WNjEws4zKtRNWJABpoU892", "X4QTPPGhjzjJSVbTTETRUK", "XUcCMQRrLoqxtCV4Hc9F2a",
      "XX65orYkXVMqTQu7C3JUZY", "XyJK3D4eSbPWgNt9Bw4RyU", "YiQMoSRPZzKeHRDhZkwmyd",
      "YkDjArg6hKdFYEmdiPrztY", "ZDKh9BtehT8SorZTrWLJsn"
    ];
    
    // Convert task IDs to BenchmarkQuestion format
    const tasks: TerminalBenchTask[] = taskIds.map((harborId, index) => ({
      id: `terminal-bench-${index + 1}`,
      harborTaskId: harborId, // Real Harbor task ID  
      harborTaskName: TASK_ID_TO_NAME[harborId] || harborId, // Harbor task name
      question: `Terminal-Bench task ${TASK_ID_TO_NAME[harborId] || harborId}`,
      correctAnswer: 'pass', // Harbor determines pass/fail
      metadata: {
        dataset: 'terminal-bench',
        version: '2.0',
        taskNumber: index + 1,
        harborTaskId: harborId,
        harborTaskName: TASK_ID_TO_NAME[harborId]
      }
    }));
    
    return tasks;
  }
  
  /**
   * Fallback sample tasks for testing when Harbor is not available
   */
  private getSampleTasks(): TerminalBenchTask[] {
    return [
      {
        id: "terminal-bench-sample-1",
        harborTaskId: "sample-1",
        question: "Build linux kernel linux-6.9 from source. Add printk(KERN_INFO \"Hello, this is a custom kernel\"); to the function start_kernel. Generate the ramfs with gen_init_cpio and run qemu.",
        correctAnswer: "pass",
        metadata: {
          difficulty: "medium",
          category: "system-administration",
          source: "build-linux-kernel-qemu",
          isSample: true
        }
      },
      {
        id: "terminal-bench-sample-2",
        harborTaskId: "sample-2",
        question: "Configure a git server so that I can push changes and have them automatically deployed to a webserver running on port 8080. The webserver should serve the pushed files.",
        correctAnswer: "pass",
        metadata: {
          difficulty: "hard",
          category: "system-administration",
          source: "configure-git-webserver",
          isSample: true
        }
      },
      {
        id: "terminal-bench-sample-3",
        harborTaskId: "sample-3",
        question: "You need to create a file called '/app/solution.txt' with the word found in 'secret_file.txt' in the 'secrets.7z' archive.",
        correctAnswer: "pass",
        metadata: {
          difficulty: "medium",
          category: "security",
          source: "crack-7z-hash",
          isSample: true
        }
      }
    ];
  }
  
  /**
   * Run multiple tasks using Harbor (batch execution)
   * This is the preferred method for Terminal-Bench
   * 
   * @param taskIds - Array of Harbor task IDs to run (e.g., ["2Fx6Ues7VLnYo5TdH9smXE", ...])
   * @param model - Model to use for execution
   * @param options - Additional options (agent, environment, seed)
   */
  async runBatch(
    taskNames: string[],  // Harbor task names like "pypi-server", not IDs
    model: string,
    options: {
      agent?: string;
      environment?: 'daytona' | 'modal';
      seed?: number;
    } = {}
  ): Promise<{ tasks: HarborTask[] }> {
    const {
      agent = 'claude-code',
      environment = 'daytona', // Using Daytona (Modal has Python installation issues)
      seed = 42
    } = options;

    console.log(`🔍 Checking if Harbor is installed...`);
    const isInstalled = await harborClient.checkInstalled();
    console.log(`🔍 Harbor installed: ${isInstalled}`);
    
    if (!isInstalled) {
      console.warn(`⚠️ Harbor not installed. Returning simulated failures.`);
      return {
        tasks: taskNames.map(name => ({
          id: name,
          instruction: `Terminal-Bench task ${name}`,
          success: false,
          error: 'Harbor not installed',
          durationMs: 0
        }))
      };
    }

    try {
      console.log(`  Calling Harbor to run ${taskNames.length} tasks from Terminal-Bench 2.0`);
      console.log(`  Model: ${model} (Rose model - routed via Rose API)`);
      console.log(`  Agent: rose-agent (custom), Environment: ${environment}`);
      console.log(`  Task names: ${taskNames.join(', ')}`);
      
      // Custom agent path - use Harbor's installed agents directory
      const customAgentPath = 'harbor.agents.installed.rose_agent:RoseAgent';
      
      // Use dataset reference - Harbor will download/cache tasks automatically
      const result = await harborClient.run({
        dataset: 'terminal-bench',
        version: '2.0',
        model,  // Pass Rose model name (e.g., "rose-labs/rose-1-fast")
        agent: 'rose-agent',  // Use our custom agent
        agentImportPath: customAgentPath,
        environment,
        tasks: taskNames,  // Filter to only run these specific tasks
        nConcurrent: 1
      });

      console.log(`  Harbor completed: success=${result.success}, ${result.tasks.length} tasks`);
      
      if (!result.success || result.tasks.length === 0) {
        throw new Error(result.errorMessage || 'Harbor returned no tasks');
      }

      return { tasks: result.tasks };
    } catch (error: any) {
      console.error(`❌ Error running Harbor:`, error);
      throw error;
    }
  }

  /**
   * Run a single task using Harbor
   * This replaces the formatPrompt -> LLM -> extractAnswer flow
   */
  async runTask(
    task: TerminalBenchTask,
    model: string,
    options: {
      agent?: string;
      environment?: 'daytona' | 'modal';
      seed?: number;
    } = {}
  ): Promise<HarborTask> {
    console.log(`🔍 runTask() called for task: ${task.id}`);
    
    const {
      agent = 'claude-code',  // Default Harbor agent
      environment = 'daytona',
      seed = 42
    } = options;

    console.log(`🔍 Checking if Harbor is installed...`);
    // Check if Harbor is available
    const isInstalled = await harborClient.checkInstalled();
    console.log(`🔍 Harbor installed: ${isInstalled}`);
    if (!isInstalled) {
      // Simulate a failed task
      return {
        id: task.id,
        instruction: task.question,
        success: false,
        error: 'Harbor not installed. This is a simulated result.',
        durationMs: 0
      };
    }
    
    // Run Harbor for this specific task
    try {
      console.log(`  Calling Harbor with: dataset=terminal-bench@2.0, model=${model}, agent=${agent}, env=${environment}`);
      const result = await harborClient.run({
        dataset: 'terminal-bench',
        version: '2.0',
        model,
        agent,
        environment,
        nConcurrent: 1,
        tasks: task.harborTaskId ? [task.harborTaskId] : undefined
      });
      
      console.log(`  Harbor result: success=${result.success}, tasks=${result.tasks.length}, error=${result.errorMessage}`);
      
      if (result.success && result.tasks.length > 0) {
        return result.tasks[0];
      } else {
        return {
          id: task.id,
          instruction: task.question,
          success: false,
          error: result.errorMessage || 'Unknown error',
          durationMs: result.totalDurationMs
        };
      }
    } catch (error) {
      console.error(`  Harbor exception:`, error);
      return {
        id: task.id,
        instruction: task.question,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: 0
      };
    }
  }
  
  /**
   * Format prompt - NOT USED for Terminal-Bench
   * Harbor handles prompting internally via agents
   */
  formatPrompt(question: BenchmarkQuestion, step: number, previousResponses: string[]): string {
    // This method is not used for Terminal-Bench
    // Keeping it for interface compatibility
    return question.question;
  }
  
  /**
   * Extract answer - NOT USED for Terminal-Bench
   * Harbor returns pass/fail directly from test scripts
   */
  extractAnswer(modelResponse: string): string {
    // This method is not used for Terminal-Bench
    // Keeping it for interface compatibility
    return modelResponse;
  }
  
  /**
   * Evaluate answer - for Terminal-Bench, this just returns the Harbor result
   * @param extracted - Harbor's pass/fail result ('pass' or 'fail')
   * @param correct - Expected result (always 'pass')
   */
  async evaluateAnswer(extracted: string, correct: string): Promise<boolean> {
    // For Terminal-Bench, Harbor determines pass/fail
    // The extracted answer should be 'pass' or 'fail' from Harbor
    return extracted === 'pass';
  }
}
