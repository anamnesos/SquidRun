/**
 * Parallel Test Module A
 * Worker A's contribution to parallel task demonstration
 */

/**
 * Returns current ISO timestamp
 * @returns {string} ISO 8601 formatted timestamp
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Returns the agent name
 * @returns {string} Agent identifier
 */
function getAgentName() {
  return "Worker A";
}

/**
 * Calculates the sum of an array of numbers
 * @param {number[]} arr - Array of numbers to sum
 * @returns {number} Sum of all numbers in the array
 */
function calculateSum(arr) {
  if (!Array.isArray(arr)) {
    return 0;
  }
  return arr.reduce((sum, num) => sum + (typeof num === 'number' ? num : 0), 0);
}

module.exports = {
  getTimestamp,
  getAgentName,
  calculateSum
};
