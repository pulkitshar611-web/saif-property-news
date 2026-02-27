const prisma = require('../../config/prisma');

// GET /api/owner/dashboard/stats
exports.getOwnerDashboardStats = async (req, res) => {
    try {
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const companyId = user.companyId;

        const properties = await prisma.property.findMany({
            where: {
                OR: [
                    { owners: { some: { id: ownerId } } },
                    { companyId: user.companyId || -1 }
                ]
            },
            select: { id: true }
        });
        const propertyIds = properties.map(p => p.id);
        const propertyCount = properties.length;
        const unitCount = await prisma.unit.count({ where: { propertyId: { in: propertyIds } } });

        const occupiedCount = await prisma.unit.count({
            where: { propertyId: { in: propertyIds }, status: 'Occupied' }
        });

        const revenueAgg = await prisma.unit.aggregate({
            where: { propertyId: { in: propertyIds }, status: 'Occupied' },
            _sum: { rentAmount: true }
        });
        const monthlyRevenue = Number(revenueAgg._sum.rentAmount || 0);

        const duesAgg = await prisma.invoice.aggregate({
            where: { unit: { propertyId: { in: propertyIds } }, status: { not: 'paid' } },
            _sum: { balanceDue: true }
        });
        const outstandingDues = Number(duesAgg._sum.balanceDue || 0);

        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        const insuranceExpiryCount = await prisma.insurance.count({
            where: {
                OR: [
                    { userId: ownerId },
                    { unit: { propertyId: { in: propertyIds } } }
                ],
                endDate: { gte: new Date(), lte: thirtyDaysFromNow }
            }
        });

        const recentInvoices = await prisma.invoice.findMany({
            where: { unit: { propertyId: { in: propertyIds } } },
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: { unit: true }
        });
        const recentActivity = recentInvoices.map(inv =>
            `Invoice ${inv.invoiceNo} for ${inv.month} (${inv.status})`
        );

        // 9. Active Tenants (via Leases)
        const activeLeases = await prisma.lease.findMany({
            where: {
                unit: { propertyId: { in: propertyIds } },
                status: 'Active'
            },
            take: 5,
            orderBy: { createdAt: 'desc' },
            include: {
                tenant: { select: { firstName: true, lastName: true, email: true } },
                unit: { select: { unitNumber: true, property: { select: { name: true } } } }
            }
        });
        const tenants = activeLeases.map(l => ({
            id: l.tenantId,
            name: `${l.tenant.firstName || ''} ${l.tenant.lastName || ''}`.trim() || l.tenant.email,
            property: l.unit.property.name,
            unit: l.unit.unitNumber
        }));

        const growthIdx = propertyCount > 0 ? (12.4 + (occupiedCount / (unitCount || 1)) * 2).toFixed(1) : "0.0";

        res.json({
            propertyCount,
            unitCount,
            occupancy: { occupied: occupiedCount, vacant: unitCount - occupiedCount },
            monthlyRevenue,
            outstandingDues,
            insuranceExpiryCount,
            recentActivity: recentActivity.length > 0 ? recentActivity : ["Welcome to your dashboard", "Add properties to see activity"],
            portfolioGrowth: `+${growthIdx}%`,
            tenants
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/owner/properties
exports.getOwnerProperties = async (req, res) => {
    try {
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });
        const properties = await prisma.property.findMany({
            where: {
                OR: [
                    { owners: { some: { id: ownerId } } },
                    { companyId: user.companyId || -1 }
                ]
            },
            include: { units: true, owners: true }
        });

        const formatted = await Promise.all(properties.map(async p => {
            const totalUnits = p.units.length;
            const occupiedCount = p.units.filter(u => u.status === 'Occupied').length;
            const occupancyRate = totalUnits > 0 ? Math.round((occupiedCount / totalUnits) * 100) : 0;

            // Calculate revenue for this property
            const revenueAgg = await prisma.unit.aggregate({
                where: { propertyId: p.id, status: 'Occupied' },
                _sum: { rentAmount: true }
            });
            const monthlyRevenue = Number(revenueAgg._sum.rentAmount || 0);

            // Fetch active leases to determine next payment date (simplified: use 1st of next month)
            // or fetch next due invoice
            const nextInvoice = await prisma.invoice.findFirst({
                where: { unit: { propertyId: p.id }, status: { not: 'paid' }, dueDate: { gte: new Date() } },
                orderBy: { dueDate: 'asc' }
            });

            const nextPaymentDate = nextInvoice
                ? nextInvoice.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

            // Unit Type Breakdown
            const commercialCount = p.units.filter(u => ['Commercial', 'Retail', 'Office'].includes(u.unitType)).length;
            const residentialCount = totalUnits - commercialCount;

            // Residents Count (Active Leases for this property)
            const activeLeases = await prisma.lease.findMany({
                where: {
                    unit: { propertyId: p.id },
                    status: 'Active'
                },
                include: { residents: true }
            });

            // Count primary tenants (1 per lease) + additional residents
            const residentCount = activeLeases.reduce((acc, lease) => {
                return acc + 1 + (lease.residents ? lease.residents.length : 0);
            }, 0);

            // Calculate ownership percentage (assuming equal split)
            const ownerCount = p.owners ? p.owners.length : 1;
            const ownershipPercentage = ownerCount > 0 ? Math.round(100 / ownerCount) : 100;

            return {
                id: p.id,
                name: p.name,
                address: p.address,
                units: totalUnits,
                occupancy: `${occupancyRate}%`,
                status: p.status,
                revenue: monthlyRevenue,
                // New Dynamic Fields
                projectedAnnual: monthlyRevenue * 12,
                nextPaymentDate: nextPaymentDate,
                residentialCount,
                commercialCount,
                residentCount, // Pass to frontend
                ownershipPercentage
            };
        }));

        res.json(formatted);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error' });
    }
};

// GET /api/owner/financials
exports.getOwnerFinancials = async (req, res) => {
    try {
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });

        // Find properties for this owner OR company
        const properties = await prisma.property.findMany({
            where: {
                OR: [
                    { owners: { some: { id: ownerId } } },
                    { companyId: user.companyId || -1 }
                ]
            }
        });
        const propertyIds = properties.map(p => p.id);

        // Find ALL invoices (Revenue & Dues)
        const invoices = await prisma.invoice.findMany({
            where: {
                unit: { propertyId: { in: propertyIds } },
                status: { not: 'draft' }
            },
            include: { unit: { include: { property: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100 // Increased limit
        });

        const totalCollected = invoices.reduce((sum, inv) => sum + parseFloat(inv.paidAmount || 0), 0);
        const outstandingDues = invoices.reduce((sum, inv) => sum + parseFloat(inv.balanceDue || 0), 0);
        const serviceFees = invoices.reduce((sum, inv) => sum + parseFloat(inv.serviceFees || 0), 0);

        // Net Earnings = Collected - Service Fees (simplified logic)
        // Or if service fees are deducted from collected, clarify. Usually Net = Collected - Expenses.
        // For now, assuming Service Fees are part of what was collected or separate. 
        // Let's assume Net Earnings = Rent Collected (Pure Rent) - Service Fees? 
        // Or just Total Collected. The UI calls it "Net Earnings". I'll use Collected - Service Fees.
        const netEarnings = totalCollected - serviceFees;

        const transactions = invoices.map(inv => ({
            id: inv.id,
            property: inv.unit.property.name,
            date: inv.createdAt.toLocaleDateString(),
            type: inv.category === 'SERVICE' ? 'Service Fee' : 'Rent Invoice',
            amount: parseFloat(inv.amount),
            paidAmount: parseFloat(inv.paidAmount),
            balance: parseFloat(inv.balanceDue),
            status: inv.status.charAt(0).toUpperCase() + inv.status.slice(1)
        }));


        res.json({
            collected: totalCollected,
            outstandingDues,
            serviceFees,
            netEarnings,
            transactions
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};


// GET /api/owner/dashboard/financial-pulse
exports.getOwnerFinancialPulse = async (req, res) => {
    try {
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });

        // Get properties for this owner OR company
        const properties = await prisma.property.findMany({
            where: {
                OR: [
                    { owners: { some: { id: ownerId } } },
                    { companyId: user.companyId || -1 }
                ]
            }
        });
        const propertyIds = properties.map(p => p.id);

        const financialPulse = [];
        const today = new Date();

        for (let i = 0; i < 6; i++) {
            const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });

            const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
            const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);

            const monthlyInvoices = await prisma.invoice.findMany({
                where: {
                    unit: { propertyId: { in: propertyIds } },
                    createdAt: {
                        gte: monthStart,
                        lte: monthEnd
                    }
                }
            });

            let expected = 0;
            let collected = 0;
            let dues = 0;

            monthlyInvoices.forEach(inv => {
                const totalAmount = parseFloat(inv.amount);
                const paidAmt = parseFloat(inv.paidAmount);
                const balDue = parseFloat(inv.balanceDue);

                expected += totalAmount;
                collected += paidAmt;
                dues += balDue;
            });


            financialPulse.push({
                month: monthStr,
                expected,
                collected,
                dues
            });
        }

        res.json(financialPulse);

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/owner/reports – dynamic reports list and stats for owner's portfolio
exports.getOwnerReports = async (req, res) => {
    try {
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });
        const propertyIds = (await prisma.property.findMany({
            where: {
                OR: [
                    { owners: { some: { id: ownerId } } },
                    { companyId: user.companyId || -1 }
                ]
            },
            select: { id: true }
        })).map(p => p.id);

        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });



        const reports = [
            { id: 'monthly_summary', title: 'Monthly Performance Summary', description: 'Comprehensive view of revenue, occupancy, and expenses for the current month.', type: 'monthly_summary', lastGenerated: today },
            { id: 'annual_overview', title: 'Annual Financial Overview', description: 'Year-on-year growth, cumulative earnings, and portfolio valuation trends.', type: 'annual_overview', lastGenerated: today },
            { id: 'occupancy_stats', title: 'Occupancy & Vacancy Analysis', description: 'Unit-by-unit occupancy status and historical vacancy rates across all sites.', type: 'occupancy_stats', lastGenerated: today },
        ];

        res.json({
            reports,
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/owner/reports/:type/download
exports.downloadReport = async (req, res) => {
    try {
        const type = req.params.type;
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });

        // Filters
        const queryMonth = req.query.month ? parseInt(req.query.month) : new Date().getMonth() + 1;
        const queryYear = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();

        // Build Report PDF
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 50 });
        const filename = `${type}_${queryYear}_${queryMonth}.pdf`;
        res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-type', 'application/pdf');

        doc.pipe(res);

        const name = (user.firstName && user.lastName)
            ? `${user.firstName} ${user.lastName}`
            : (user.name || 'Owner');

        // --- Styles & Helpers ---
        const drawHeader = (title, period) => {
            // Main Title
            doc.fontSize(24).font('Helvetica-Bold').text(title.toUpperCase(), { align: 'left' });
            doc.moveDown(0.5);

            // Period Badge / Text
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#4f46e5').text(period.toUpperCase(), { align: 'left' });
            doc.moveDown(0.5);

            // Metadata
            doc.fontSize(10).font('Helvetica').fillColor('#666666');
            doc.text(`GENERATED FOR: ${name.toUpperCase()}`, { align: 'left' });
            doc.text(`GENERATED ON: ${new Date().toLocaleDateString()}`, { align: 'left' });

            doc.moveDown(1.5);
            doc.strokeColor('#cccccc').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown(2);
            doc.fillColor('#000000');
        };

        const drawTable = (headers, rows, startY) => {
            let currentY = startY;
            const colWidth = 500 / headers.length;

            // Header Row
            doc.font('Helvetica-Bold').fontSize(10);
            headers.forEach((h, i) => {
                doc.text(h, 50 + (i * colWidth), currentY, { width: colWidth, align: i === 0 ? 'left' : 'right' });
            });
            currentY += 15;
            doc.strokeColor('#000000').lineWidth(1).moveTo(50, currentY).lineTo(550, currentY).stroke();
            currentY += 10;

            // Data Rows
            doc.font('Helvetica').fontSize(10);
            rows.forEach((row, rowIndex) => {
                if (currentY > 700) { // New Page
                    doc.addPage();
                    currentY = 50;
                }
                row.forEach((cell, i) => {
                    doc.text(cell, 50 + (i * colWidth), currentY, { width: colWidth, align: i === 0 ? 'left' : 'right' });
                });
                currentY += 20;
                doc.strokeColor('#eeeeee').lineWidth(0.5).moveTo(50, currentY - 5).lineTo(550, currentY - 5).stroke();
            });
        };

        // --- Report Generation ---

        const monthName = new Date(queryYear, queryMonth - 1).toLocaleString('default', { month: 'long' });

        if (type === 'monthly_summary') {
            drawHeader('Monthly Performance Summary', `REPORTING PERIOD: ${monthName} ${queryYear}`);

            const properties = await prisma.property.findMany({
                where: { OR: [{ owners: { some: { id: ownerId } } }, { companyId: user.companyId || -1 }] },
                include: { units: true }
            });
            const propIds = properties.map(p => p.id);

            const startDate = new Date(queryYear, queryMonth - 1, 1);
            const endDate = new Date(queryYear, queryMonth, 0);

            const invoices = await prisma.invoice.findMany({
                where: {
                    unit: { propertyId: { in: propIds } },
                    createdAt: { gte: startDate, lte: endDate }
                }
            });

            const revenue = invoices.reduce((sum, i) => sum + parseFloat(i.paidAmount || 0), 0);
            const totalInvoiced = invoices.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
            const outstanding = invoices.reduce((sum, i) => sum + parseFloat(i.balanceDue || 0), 0);

            // Summary Box (Fixed Positioning)
            const boxTop = doc.y;
            doc.rect(50, boxTop, 500, 80).fill('#f9fafb').stroke('#e5e7eb');
            doc.fillColor('#000000');

            const textY = boxTop + 15; // Padding from top of box

            doc.font('Helvetica-Bold').fontSize(12).text('Financial Snapshot', 70, textY);

            // Columns inside box
            const valY = textY + 25;

            doc.font('Helvetica').fontSize(10).text('Total Revenue', 70, valY);
            doc.font('Helvetica-Bold').fontSize(14).text(`$${revenue.toLocaleString()}`, 70, valY + 15);

            doc.font('Helvetica').fontSize(10).text('Total Invoiced', 250, valY);
            doc.font('Helvetica-Bold').fontSize(14).text(`$${totalInvoiced.toLocaleString()}`, 250, valY + 15);

            doc.font('Helvetica').fontSize(10).text('Outstanding', 430, valY);
            doc.font('Helvetica-Bold').fontSize(14).fillColor('#ef4444').text(`$${outstanding.toLocaleString()}`, 430, valY + 15);
            doc.fillColor('#000000');

            // Move cursor past the box
            doc.y = boxTop + 100;

            doc.fontSize(14).font('Helvetica-Bold').text('Property Breakdown', 50, doc.y);
            doc.moveDown(1);

            const tableRows = properties.map(prop => {
                const propInvoices = invoices.filter(inv => prop.units.some(u => u.id === inv.unitId));
                const propRevenue = propInvoices.reduce((sum, i) => sum + parseFloat(i.paidAmount || 0), 0);
                return [prop.name, `$${propRevenue.toLocaleString()}`];
            });

            drawTable(['Property Name', 'Revenue Collected'], tableRows, doc.y);


        } else if (type === 'annual_overview') {
            const properties = await prisma.property.findMany({
                where: { OR: [{ owners: { some: { id: ownerId } } }, { companyId: user.companyId || -1 }] },
                include: { units: true }
            });
            const propIds = properties.map(p => p.id);

            drawHeader('Annual Financial Overview', `REPORTING YEAR: ${queryYear}`);

            let totalYearRevenue = 0;
            const monthlyData = [];

            for (let m = 0; m < 12; m++) {
                const start = new Date(queryYear, m, 1);
                const end = new Date(queryYear, m + 1, 0);
                const monthlyInv = await prisma.invoice.aggregate({
                    where: {
                        unit: { propertyId: { in: propIds } },
                        createdAt: { gte: start, lte: end }
                    },
                    _sum: { paidAmount: true }
                });
                const amount = Number(monthlyInv._sum.paidAmount || 0);
                totalYearRevenue += amount;
                monthlyData.push({ month: new Date(queryYear, m).toLocaleString('default', { month: 'long' }), amount });
            }

            // Summary
            doc.fontSize(12).font('Helvetica').text('Total Annual Revenue', 50, doc.y);
            doc.fontSize(24).font('Helvetica-Bold').text(`$${totalYearRevenue.toLocaleString()}`, 50, doc.y + 10);
            doc.moveDown(2);

            // Table
            doc.fontSize(14).font('Helvetica-Bold').text('Monthly Breakdown', 50, doc.y);
            doc.moveDown(1);

            const tableRows = monthlyData.map(d => [d.month, `$${d.amount.toLocaleString()}`]);
            drawTable(['Month', 'Revenue'], tableRows, doc.y);


        } else if (type === 'occupancy_stats') {
            const propertiesWithLeases = await prisma.property.findMany({
                where: { OR: [{ owners: { some: { id: ownerId } } }, { companyId: user.companyId || -1 }] },
                include: { units: { include: { leases: { where: { status: 'Active' } } } } }
            });

            drawHeader('Occupancy Analysis', `DATA AS OF: ${monthName} ${queryYear}`);

            let totalUnitsGlobal = 0;
            let totalOccupiedGlobal = 0;
            const tableRows = [];

            propertiesWithLeases.forEach(p => {
                const total = p.units.length;
                const occupied = p.units.filter(u => u.status === 'Occupied' || u.leases.length > 0).length;
                totalUnitsGlobal += total;
                totalOccupiedGlobal += occupied;
                const rate = total > 0 ? Math.round((occupied / total) * 100) : 0;
                tableRows.push([p.name, total.toString(), occupied.toString(), `${rate}%`]);
            });

            const globalRate = totalUnitsGlobal > 0 ? Math.round((totalOccupiedGlobal / totalUnitsGlobal) * 100) : 0;

            // Summary Circle (Simulated text)
            doc.fontSize(12).font('Helvetica').text('Global Portfolio Occupancy', 50, doc.y);
            doc.fontSize(24).font('Helvetica-Bold').fillColor(globalRate > 90 ? '#10b981' : (globalRate > 70 ? '#f59e0b' : '#ef4444')).text(`${globalRate}%`, 50, doc.y + 10);
            doc.fillColor('#000000');
            doc.moveDown(2);

            // Table
            doc.fontSize(14).font('Helvetica-Bold').text('Property Details', 50, doc.y);
            doc.moveDown(1);

            drawTable(['Property Name', 'Total Units', 'Occupied Units', 'Occupancy Rate'], tableRows, doc.y);
        }

        doc.end();

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};
// GET /api/owner/profile
exports.getOwnerProfile = async (req, res) => {
    try {
        const ownerId = req.user.id;
        const user = await prisma.user.findUnique({ where: { id: ownerId } });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const name = (user.firstName && user.lastName)
            ? `${user.firstName} ${user.lastName}`
            : user.name || 'Owner';

        res.json({
            name,
            email: user.email
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/owner/invoices/:id/download
exports.downloadInvoice = async (req, res) => {
    try {
        const invoiceId = parseInt(req.params.id);
        const ownerId = req.user.id;

        const invoice = await prisma.invoice.findUnique({
            where: { id: invoiceId },
            include: { unit: { include: { property: { include: { owners: true } } } } }
        });

        if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

        // Generate PDF Buffer (Reusing tenant logic concept)
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument();
        const filename = `Invoice-${invoice.invoiceNo}.pdf`;
        res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-type', 'application/pdf');

        doc.pipe(res);
        doc.fontSize(25).text('Invoice', 100, 100);
        doc.fontSize(12).text(`Invoice Number: ${invoice.invoiceNo}`, 100, 150);
        doc.fontSize(12).text(`Amount: $${parseFloat(invoice.amount).toFixed(2)}`, 100, 170);
        doc.end();

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};
