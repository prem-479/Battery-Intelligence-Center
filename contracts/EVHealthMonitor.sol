// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EVHealthMonitor {
    address public owner;
    address public authorizedOracle;

    mapping(bytes32 => bool) public registeredVehicles;
    mapping(bytes32 => HealthRecord[]) public vehicleHistory;
    mapping(bytes32 => HealthRecord) public latestHealth;

    struct HealthRecord {
        uint256 timestamp;
        uint256 soH;
        uint256 temperature;
        uint256 voltage;
        uint256 errorCode;
    }

    event HealthLogged(
        bytes32 indexed vehicleId,
        uint256 indexed timestamp,
        uint256 soH,
        uint256 temperature,
        uint256 voltage,
        uint256 errorCode
    );

    event AlertTriggered(
        bytes32 indexed vehicleId,
        uint256 indexed timestamp,
        string message,
        uint256 triggerValue,
        uint256 severity
    );

    constructor() {
        owner = msg.sender;
        authorizedOracle = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, 'Only owner');
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == authorizedOracle, 'Only oracle');
        _;
    }

    function setOracle(address newOracle) external onlyOwner {
        authorizedOracle = newOracle;
    }

    function registerVehicle(bytes32 vehicleId) external onlyOwner {
        registeredVehicles[vehicleId] = true;
    }

    function logVehicleHealth(
        bytes32 vehicleId,
        uint256 soH,
        uint256 temperature,
        uint256 voltage,
        uint256 errorCode
    ) external onlyOracle {
        require(registeredVehicles[vehicleId], 'Vehicle not registered');

        HealthRecord memory record = HealthRecord({
            timestamp: block.timestamp,
            soH: soH,
            temperature: temperature,
            voltage: voltage,
            errorCode: errorCode
        });

        vehicleHistory[vehicleId].push(record);
        latestHealth[vehicleId] = record;
        emit HealthLogged(vehicleId, block.timestamp, soH, temperature, voltage, errorCode);

        if (temperature > 45) {
            emit AlertTriggered(vehicleId, block.timestamp, 'Overheating', temperature, 1);
        }

        if (soH < 75) {
            emit AlertTriggered(vehicleId, block.timestamp, 'Battery degradation', soH, 2);
        }

        if (errorCode != 0) {
            emit AlertTriggered(vehicleId, block.timestamp, 'Critical fault', errorCode, 3);
        }
    }

    function getLatestHealth(bytes32 vehicleId) external view returns (uint256, uint256, uint256, uint256, uint256) {
        HealthRecord memory record = latestHealth[vehicleId];
        return (record.timestamp, record.soH, record.temperature, record.voltage, record.errorCode);
    }

    function vehicleHistoryLength(bytes32 vehicleId) external view returns (uint256) {
        return vehicleHistory[vehicleId].length;
    }
}
