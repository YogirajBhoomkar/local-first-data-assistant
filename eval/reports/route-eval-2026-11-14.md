# Effort routing: rules vs rules + Laya (2026-11-14)

Laya checkpoint requested from the server: typed-decisions. 30 table questions. Gold effort is a judgement call: low = simple, medium = q022 and q023, high = everything else.
A question rated "high" goes straight to the remote model; low and medium are tried locally.

| signals | 3-class accuracy | high caught (tp) | wrongly high (fp) | missed high (fn) | tn | recall of high | precision of high |
|---|---|---|---|---|---|---|---|
| rules only | 86.7% | 9 | 3 | 1 | 17 | 90.0% | 75.0% |
| rules + Laya | 86.7% | 9 | 3 | 1 | 17 | 90.0% | 75.0% |

## Per question
| id | gold | rules | rules + Laya | question |
|---|---|---|---|---|
| q001 | low | low | low | How many policies are there? |
| q002 | low | low | low | How many active policies are there? |
| q003 | low | low | low | What is the total premium amount? |
| q004 | low | high (x) | high (x) | What is the total premium for the EMEA region? |
| q005 | low | low | low | How many policies are there per line of business? |
| q006 | low | high (x) | high (x) | Show total premium by region. |
| q007 | low | low | low | Which 5 brokers have the highest total premium? |
| q008 | low | low | low | What is the average limit amount for Marine policies? |
| q009 | low | low | low | How many policies were cancelled? |
| q010 | low | low | low | What is the largest limit amount of any policy? |
| q011 | low | low | low | How many claims are there? |
| q012 | low | low | low | What is the total paid amount on claims? |
| q013 | low | low | low | How many open claims are there? |
| q014 | low | low | low | Show the number of claims by cause. |
| q015 | low | low | low | What are the top 3 causes of loss by total paid amount? |
| q016 | low | low | low | What is the total insured value by country? |
| q017 | low | low | low | How many exposure rows have the flood peril? |
| q018 | low | high (x) | high (x) | What is the total planned premium? |
| q019 | high | high | high | What is the total paid amount on claims for EMEA policies? |
| q020 | high | high | high | Which line of business has the highest loss ratio (paid claims divided by premium)? |
| q021 | high | high | high | How many claims were reported by brokers with more than 50 policies? |
| q022 | medium | medium | medium | What is the average number of days between loss date and reported date? |
| q023 | medium | medium | medium | Compare total paid amount in 2022 versus 2023. |
| q024 | high | high | high | Why is premium so much higher in some regions than others? |
| q025 | high | high | high | Explain the trend in claims over time. |
| q026 | high | low (x) | low (x) | Which policies are at risk? |
| q027 | high | high | high | How do actual premiums compare to the plan by month? |
| q028 | high | high | high | What is the total insured value for policies that are currently active? |
| q029 | high | high | high | Forecast the number of claims next quarter. |
| q030 | high | high | high | Recommend which brokers we should review based on claims. |
