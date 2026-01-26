/**
 * Parallel Test Module - Worker B
 * Created for parallel task execution test
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
  return "Worker B";
}

/**
 * Multiplies an array of numbers together
 * @param {number[]} arr - Array of numbers to multiply
 * @returns {number} Product of all numbers (1 if empty array)
 */
function calculateProduct(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return 1;
  }
  return arr.reduce((product, num) => product * num, 1);
}

module.exports = {
  getTimestamp,
  getAgentName,
  calculateProduct
};
