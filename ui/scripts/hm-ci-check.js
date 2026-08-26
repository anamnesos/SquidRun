#!/usr/bin/env node

const { execSync } = require('child_process');

function runCheck() {
  try {
    // Get the latest run on main
    const runOutput = execSync('gh run list --branch main --limit 1 --json status,conclusion,url,displayTitle,databaseId', { encoding: 'utf-8' });
    const runs = JSON.parse(runOutput);

    if (runs.length === 0) {
      console.log('No CI runs found for main branch.');
      return;
    }

    const run = runs[0];
    
    if (run.conclusion === 'success') {
      console.log(`[PASS] CI is green! Latest run: ${run.displayTitle}`);
      console.log(`URL: ${run.url}`);
      return;
    }

    if (run.conclusion === 'failure') {
      console.log(`[FAIL] CI is red. Latest run: ${run.displayTitle}`);
      console.log(`URL: ${run.url}`);
      
      console.log('\nAnalyzing failed suites...');
      try {
        const logOutput = execSync(`gh run view ${run.databaseId} --log-failed`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const lines = logOutput.split('\n');
        
        const failedSuites = new Set();
        for (const line of lines) {
          if (line.includes('FAIL') && line.includes('__tests__/')) {
            const match = line.match(/FAIL\s+(.*\.test\.js)/);
            if (match && match[1]) {
              failedSuites.add(match[1].trim());
            }
          }
        }
        
        if (failedSuites.size > 0) {
          console.log(`Failed suites:`);
          for (const suite of failedSuites) {
            console.log(` - ${suite}`);
          }
        } else {
          console.log('Could not identify specific failed suites from the log.');
        }
      } catch (err) {
        console.log('Failed to fetch or parse job logs.');
      }
      
      // Exit with code 1 so it fails the startup check if implemented that way
      process.exit(1);
    }

    console.log(`[STATUS] CI status is ${run.status} (${run.conclusion}). Latest run: ${run.displayTitle}`);

  } catch (error) {
    console.error('Failed to query GitHub Actions status. Make sure the "gh" CLI is installed and authenticated.');
    console.error(error.message);
  }
}

runCheck();
