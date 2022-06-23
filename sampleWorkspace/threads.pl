use strict;
use warnings;
use threads;

my $Param3 = 'foo';
my $thr1 = threads->create(\&sub1, 'Param 1', 'Param 2', $Param3);
my @ParamList = (42, 'Hello', 3.14);
my $thr2 = threads->create(\&sub1, @ParamList);
my $thr3 = threads->create(\&sub1, qw(Param1 Param2 Param3));

sub sub1 {
    my @InboundParameters = @_;
    print("In the thread\n");
    print('Got parameters >', join('<>',@InboundParameters), "<\n");
}