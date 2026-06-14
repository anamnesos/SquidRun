# PC Hardware Backlog (relocated from task-audit sidecar, 2026-06-14)

These are James's machine-tuning notes — NOT SquidRun product/coordination work. Relocated out of the task-audit sidecar (S446 prune #4) so they don't pollute James's canonical Today surface. Content preserved verbatim; nothing deleted.

## EXPO resolved: RAM is running rated DDR5-6000
- id: `pc-hardware-expo-off-ddr5-6000-401` · status: resolved · kind: hardware_firmware_tuning · owner: builder
- rationale: The original 4800/EXPO-off audit is stale. Live Win32_PhysicalMemory now reports both installed Corsair CMH64GX5M2M6000Z30 DIMMs with Speed=6000 and ConfiguredClockSpeed=6000, matching the rated DDR5-6000 kit speed.
- next action: No BIOS/EXPO action remains unless a future live probe drops below rated DDR5-6000.

## Driver currency: RTX 5090 driver is behind; AMD chipset is current
- id: `pc-hardware-gpu-driver-currency-401` · status: to_do · kind: driver_currency · owner: builder
- rationale: NVIDIA remains open: the machine is on nvidia-smi 596.21 / WMI 32.0.15.9621 dated 2026-04-12, while NVIDIA's official driver page shows 596.36 WHQL for RTX 5090. AMD is resolved: registry shows AMD Chipset Software and AMD_Chipset_Drivers 8.05.04.516 installed, matching AMD's official X870E latest 8.05.04.516 release.
- next action: NVIDIA-only: James-gated install decision for GeForce Game Ready Driver 596.36 via NVIDIA App or manual installer. No AMD chipset action remains.

## Memory Integrity / VBS disable is authorized for performance
- id: `pc-hardware-memory-integrity-vbs-check-401` · status: to_do · kind: os_hardware_performance_check · owner: builder,oracle
- rationale: Win32_DeviceGuard reports VirtualizationBasedSecurityStatus=2 and SecurityServicesRunning includes 2, which means VBS and Hypervisor-enforced Code Integrity / Memory Integrity are running. James authorized the aggressive low-threat performance tradeoff, so this now belongs in the reversible elevated script instead of remaining a decision-only item.
- next action: Run the one-click elevated script, reboot, then verify DeviceGuard/Memory Integrity is off. Restore mode must be available if James wants the security posture back.

## BIOS currency: FA9 / AGESA 1.2.8.0 needs a rev-confirmed update
- id: `pc-hardware-bios-currency-fa9-x870e-401` · status: to_do · kind: bios_currency · owner: builder
- rationale: The board is on Gigabyte FA9 dated 2026-02-04 with SMBIOS AGESA ComboAm5PI 1.2.8.0. Gigabyte's X870E AORUS ELITE WIFI7 support pages are revision-specific and use distinct BIOS lines: rev 1.0/1.1 lists F12, rev 1.2 lists FB1, and rev 1.3 lists F6 for the May 21, 2026 AGESA 1.3.0.1 update. WMI/SMBIOS reports Default string for revision and serial, so the exact board rev is not programmatically proven.
- next action: Confirm the board revision manually in GIGABYTE Control Center, BIOS info, or the PCB REV silkscreen before downloading the matching BIOS from Gigabyte. Then flash via Q-Flash from FAT32 USB, re-enable EXPO, and retest stability.

## Samsung SSD firmware: verify exact 4TB model before flashing
- id: `pc-hardware-990-pro-firmware-health-401` · status: to_do · kind: storage_firmware_health · owner: builder
- rationale: Windows storage APIs report both drives as Samsung SSD 990 PRO with firmware 4B2QJXD7, but the MicroCenter build receipt lists the 4TB drive as Samsung 990 EVO Plus 4TB. 990 Pro and 990 EVO Plus use different firmware paths, so Pro firmware must not be applied to the 4TB drive until Samsung Magician confirms the exact model.
- next action: Install/run Samsung Magician, record each drive's exact model and serial, then update firmware per drive only through Magician or the matching official Samsung model page. Treat the 2TB as 990 Pro per receipt; verify the 4TB before any firmware flash.

## RTX 5090 is running PCIe x8; map lane consumers before moving hardware
- id: `pc-hardware-gpu-pcie-lane-audit-401` · status: to_do · kind: pcie_lane_analysis · owner: builder
- rationale: nvidia-smi showed the RTX 5090 link at x8 while the board supports x16. Gigabyte's X870E AORUS ELITE WIFI7 specs say CPU M2B/M2C slots share bandwidth with PCIEX16, and the receipt confirms an Intel X550-AT2 10GbE add-in card is also installed. The GPU x8 state may be expected from M.2 placement or add-in-card layout rather than a GPU fault.
- next action: Use BIOS board explorer/manual slot map plus Windows Device Manager/HWiNFO to identify which M.2 slots and PCIe slots are populated. Only move hardware if the map shows a clear way to regain x16 without sacrificing needed NVMe or 10GbE function.

## 9950X PBO / Curve Optimizer tuning opportunity
- id: `pc-hardware-9950x-pbo-curve-optimizer-401` · status: to_do · kind: cpu_tuning · owner: builder
- rationale: The 9950X can often hold better boost clocks with PBO plus a validated negative Curve Optimizer, but it must come after RAM stability and live thermal proof.
- next action: Capture live CPU temps in HWiNFO/Ryzen Master, keep CPPC/preferred cores enabled, then test modest negative Curve Optimizer settings with OCCT/Cinebench/y-cruncher and WHEA monitoring.

## DDR5 4-stick verdict: keep the spare 2x32GB kit in the drawer
- id: `pc-hardware-ddr5-four-stick-verdict-401` · status: decided · kind: hardware_capacity_decision · owner: builder
- rationale: Four 32GB DDR5 DIMMs on AM5 move the system from the fast 1-DIMM-per-channel path to the harder 2-DIMM-per-channel path and can force much lower speed or instability, even with matching part numbers from separate kits. Live inventory confirms only 2x32GB is installed now and both DIMMs are running at configured 6000.
- next action: No pending action. Reopen only if James has a real >64GB workload such as huge local LLM offload, large VMs, or large CPU-side datasets.

